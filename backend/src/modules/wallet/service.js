import prisma from '../../utils/db.js';
import logger from '../../utils/logger.js';
import {
  InsufficientFundsError,
  lockWalletForUpdate
} from '../../services/matchService.js';

// Canonical money contract: a non-negative bounded minor-unit integer accepted
// as a plain-digit string or number (S01). Rejects floats, signs, exponent
// notation, empty strings and anything that would overflow BigInt — senders
// must always transmit money as integer minor units, never floats.
const MAX_MINOR_UNITS = 1_000_000_000_000_000n;

export const parseMinorUnits = (raw) => {
  const str =
    typeof raw === 'number' || typeof raw === 'bigint' ? String(raw) : raw;
  if (typeof str !== 'string' || !/^\d+$/.test(str.trim())) return null;
  const value = BigInt(str.trim());
  if (value <= 0n || value > MAX_MINOR_UNITS) return null;
  return value;
};

export const parseIdempotencyKey = (raw) => {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (
    typeof raw !== 'string' ||
    !/^[A-Za-z0-9._:-]{8,128}$/.test(raw)
  ) {
    const error = new Error('Invalid idempotency key');
    error.name = 'InvalidIdempotencyKeyError';
    throw error;
  }
  return raw;
};

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
 * Request a withdrawal (reserves funds in the same transaction that creates
 * the pending request). S01:
 *  - The wallet row is locked FOR UPDATE before balance reads/debits so
 *    concurrent withdrawals and match-results serialize instead of both
 *    observing the pre-debit balance.
 *  - A client-supplied idempotencyKey makes replays return the original
 *    request instead of debiting twice; the unique (userId, idempotencyKey)
 *    index also rolls back the whole transaction if two requests race.
 */
export const requestWithdrawal = async (userId, amountMinorUnits, idempotencyKey) => {
  const amount = parseMinorUnits(amountMinorUnits);
  if (amount === null) {
    const error = new Error('Invalid amount');
    error.name = 'InvalidAmountError';
    throw error;
  }

  const key = parseIdempotencyKey(idempotencyKey);

  try {
    return await prisma.$transaction(async (tx) => {
      // 1. Lock the wallet row so balance checks and debits serialize against
      //    other money operations on the same wallet.
      const wallet = await lockWalletForUpdate(tx, userId);

      // 2. Idempotent replay: a request with this key already exists -> return it.
      if (key !== undefined) {
        const existing = await tx.withdrawalRequest.findFirst({
          where: { userId, idempotencyKey: key }
        });
        if (existing) return existing;
      }

      // 3. Verify funds while holding the lock.
      if (BigInt(wallet.balanceMinorUnits) < amount) {
        throw new InsufficientFundsError();
      }

      // 4. Debit balance (row is locked; DB CHECK rejects negatives).
      await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          balanceMinorUnits: { decrement: amount }
        }
      });

      // 5. Create WithdrawalRequest.
      const withdrawal = await tx.withdrawalRequest.create({
        data: {
          userId,
          amountMinorUnits: amount,
          status: 'PENDING',
          ...(key !== undefined ? { idempotencyKey: key } : {})
        }
      });

      // 6. Log WalletTransaction.
      await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: 'WITHDRAWAL',
          amountMinorUnits: -amount,
          status: 'PENDING'
        }
      });

      return withdrawal;
    });
  } catch (error) {
    // 7. Two requests raced with the same (userId, idempotencyKey): the whole
    //    transaction — including our debit — was rolled back by Prisma. Return
    //    the winner's request so the caller sees an identical result.
    if (error?.code === 'P2002' && key !== undefined) {
      const existing = await prisma.withdrawalRequest.findFirst({
        where: { userId, idempotencyKey: key }
      });
      if (existing) return existing;
    }
    throw error;
  }
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
