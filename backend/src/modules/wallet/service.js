import prisma from '../../utils/db.js';
import logger from '../../utils/logger.js';

/**
 * Idempotently process a successful deposit webhook.
 */
export const processDepositWebhook = async (reference, amountMinorUnits, gateway, userId) => {
  try {
    await prisma.$transaction(async (tx) => {
      // 1. Fetch wallet by userId
      const wallet = await tx.wallet.findUnique({ where: { userId } });
      if (!wallet) {
        throw new Error(`Wallet not found for userId ${userId}`);
      }

      // Create the DEPOSIT transaction. 
      // If gatewayReference already exists, this throws P2002 (Unique Constraint)
      const txRecord = await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: 'DEPOSIT',
          amountMinorUnits: BigInt(amountMinorUnits),
          gateway: gateway,
          gatewayReference: reference,
          status: 'COMPLETED'
        }
      });
      
      // Update wallet balance
      await tx.wallet.update({
        where: { id: txRecord.walletId },
        data: {
          balanceMinorUnits: { increment: BigInt(amountMinorUnits) }
        }
      });
    });
    
    logger.info({ reference, gateway }, 'Deposit webhook processed successfully');
    return true;
  } catch (error) {
    if (error.code === 'P2002') {
      // Idempotency: webhook was already processed
      logger.info({ reference, gateway }, 'Deposit webhook ignored: already processed (idempotency)');
      return true;
    }
    logger.error({ error, reference, gateway }, 'Failed to process deposit webhook');
    throw error;
  }
};

/**
 * Request a withdrawal (deducts balance immediately).
 */
export const requestWithdrawal = async (userId, amountMinorUnits) => {
  return await prisma.$transaction(async (tx) => {
    // 1. Get wallet and check balance
    const wallet = await tx.wallet.findUnique({ where: { userId } });
    if (!wallet) throw new Error('Wallet not found');
    
    if (wallet.balanceMinorUnits < BigInt(amountMinorUnits)) {
      const error = new Error('Insufficient funds');
      error.name = 'InsufficientFundsError';
      throw error;
    }
    
    // 2. Deduct balance
    await tx.wallet.update({
      where: { id: wallet.id },
      data: {
        balanceMinorUnits: { decrement: BigInt(amountMinorUnits) }
      }
    });
    
    // 3. Create WithdrawalRequest
    const withdrawal = await tx.withdrawalRequest.create({
      data: {
        userId,
        amountMinorUnits: BigInt(amountMinorUnits),
        status: 'PENDING'
      }
    });
    
    // 4. Log WalletTransaction
    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: 'WITHDRAWAL',
        amountMinorUnits: -BigInt(amountMinorUnits),
        status: 'PENDING'
      }
    });
    
    return withdrawal;
  });
};

/**
 * Reject a withdrawal and refund the user.
 */
export const rejectWithdrawal = async (withdrawalRequestId, adminId) => {
  return await prisma.$transaction(async (tx) => {
    // 1. Fetch the request to get amount and userId.
    const request = await tx.withdrawalRequest.findUnique({
      where: { id: withdrawalRequestId }
    });
    
    if (!request) {
      throw new Error('Withdrawal request not found');
    }
    
    // Check-then-act is safe here ONLY IF we also use a conditional update 
    // or rely on a lock. A conditional update is safest.
    
    // 2. Atomically update the status ONLY IF it is PENDING
    const result = await tx.$executeRaw`
      UPDATE "WithdrawalRequest"
      SET status = 'REJECTED', "reviewedBy" = ${adminId}, "reviewedAt" = NOW()
      WHERE id = ${withdrawalRequestId} AND status = 'PENDING'
    `;
    
    if (result === 0) {
      // It was already processed (approved, rejected, or missing)
      return null;
    }
    
    const wallet = await tx.wallet.findUnique({ where: { userId: request.userId } });
    
    // 3. Credit the balance back
    await tx.wallet.update({
      where: { id: wallet.id },
      data: {
        balanceMinorUnits: { increment: request.amountMinorUnits }
      }
    });
    
    // 4. Log REFUND transaction
    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: 'REFUND',
        amountMinorUnits: request.amountMinorUnits,
        status: 'COMPLETED'
      }
    });
    
    logger.info({ withdrawalRequestId, adminId }, 'Withdrawal rejected and refunded');
    return true;
  });
};

export const getWalletBalance = async (userId) => {
  const wallet = await prisma.wallet.findUnique({
    where: { userId },
    select: { balanceMinorUnits: true, currency: true }
  });
  if (!wallet) return null;
  return {
    ...wallet,
    balanceMinorUnits: wallet.balanceMinorUnits.toString()
  };
};

export const getWalletTransactions = async (userId, page = 1, limit = 20) => {
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  if (!wallet) return { transactions: [], total: 0 };

  const skip = (page - 1) * limit;
  const [transactions, total] = await Promise.all([
    prisma.walletTransaction.findMany({
      where: { walletId: wallet.id },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit
    }),
    prisma.walletTransaction.count({
      where: { walletId: wallet.id }
    })
  ]);

  return {
    transactions: transactions.map(t => ({
      ...t,
      amountMinorUnits: t.amountMinorUnits.toString()
    })),
    total,
    page,
    totalPages: Math.ceil(total / limit)
  };
};
