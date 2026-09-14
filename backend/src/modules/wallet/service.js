import crypto from 'crypto';
import prisma from '../../utils/db.js';
import logger from '../../utils/logger.js';
import {
  InsufficientFundsError,
  lockWalletForUpdate
} from '../../services/matchService.js';
import { assertEligibleForMoney } from '../../services/eligibilityService.js';

// Canonical money contract: a non-negative bounded minor-unit integer accepted
// as a plain-digit string or number. Rejects floats, signs, exponent notation,
// empty strings and anything that would overflow BigInt — senders must always
// transmit money as integer minor units, never floats.
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

// Provider webhooks (e.g. Flutterwave) send major units as decimals
// ("1250.00"). Parse those exactly to integer minor units with string math —
// never through Number(), which reintroduces floating-point drift like the
// old Math.round(Number(data.amount) * 100).
export const parseDecimalMajorToMinor = (raw) => {
  const str =
    typeof raw === 'number' || typeof raw === 'bigint' ? String(raw) : raw;
  if (typeof str !== 'string') return null;
  const m = /^\s*(\d+)(?:\.(\d{1,2}))?\s*$/.exec(str);
  if (!m) return null;
  const major = BigInt(m[1]);
  const frac = BigInt((m[2] || '').padEnd(2, '0'));
  const minor = major * 100n + frac;
  if (minor < 1n || minor > MAX_MINOR_UNITS) return null;
  return minor;
};

/**
 * Creates and persists a server-owned deposit intent BEFORE any checkout is
 * exposed. The provider is then handed OUR reference (custom reference /
 * tx_ref), so every later webhook can be verified against this record and
 * credit is derived from it — never from the raw webhook body.
 */
export const createDepositIntent = async (userId, amountMinorUnits, gateway, email) => {
  const amount = parseMinorUnits(amountMinorUnits);
  if (amount === null) {
    const error = new Error('Invalid amount');
    error.name = 'InvalidAmountError';
    throw error;
  }
  if (gateway !== 'PAYSTACK' && gateway !== 'FLUTTERWAVE') {
    const error = new Error('Invalid gateway');
    error.name = 'InvalidGatewayError';
    throw error;
  }

  const reference = `${gateway.toLowerCase()}-${crypto.randomUUID()}`;

  return await prisma.$transaction(async (tx) => {
    const wallet = await tx.wallet.findUnique({ where: { userId } });
    if (!wallet) {
      const error = new Error(`Wallet not found for userId ${userId}`);
      error.name = 'WalletNotFoundError';
      throw error;
    }
    // Phase 1 supports NGN only; a GBP wallet must never be credited in kobo.
    if (wallet.currency !== 'NGN') {
      const error = new Error('Deposits are only supported for NGN wallets');
      error.name = 'UnsupportedCurrencyError';
      throw error;
    }
    return tx.depositIntent.create({
      data: {
        userId,
        walletId: wallet.id,
        gateway,
        reference,
        amountMinorUnits: amount,
        currency: wallet.currency
      }
    });
  });
};

/**
 * Idempotently process a successful deposit webhook, verified against the
 * stored intent. Returns one of:
 *   { handled: true,  alreadyApplied: false, intent, transaction } — newly credited
 *   { handled: false, alreadyApplied: true }                          — duplicate/replay
 *   { handled: false, reason: UNKNOWN_REFERENCE | GATEWAY_MISMATCH | USER_MISMATCH |
 *                            AMOUNT_MISMATCH | CURRENCY_MISMATCH }    — rejected, no credit
 *
 * The credited amount is `intent.amountMinorUnits`; the webhook amount is only
 * compared for exact equality against it.
 */
export const processDepositWebhook = async ({ reference, amountMinorUnits, currency, gateway, userId }) => {
  const webhookAmount = parseMinorUnits(amountMinorUnits);
  if (webhookAmount === null) {
    logger.warn({ reference, gateway }, 'Deposit webhook amount is not canonical minor units');
    return { handled: false, reason: 'AMOUNT_MISMATCH' };
  }

  try {
    return await prisma.$transaction(async (tx) => {
      // 1. The stored intent is the only reference that can authorize a credit.
      const intent = await tx.depositIntent.findUnique({ where: { reference } });
      if (!intent) {
        logger.warn({ reference, gateway }, 'Deposit webhook ignored: unknown reference');
        return { handled: false, reason: 'UNKNOWN_REFERENCE' };
      }
      if (intent.status === 'COMPLETED') {
        return { handled: false, alreadyApplied: true, intent };
      }
      if (intent.gateway !== gateway) {
        logger.warn({ reference }, 'Deposit webhook rejected: gateway does not match intent');
        return { handled: false, reason: 'GATEWAY_MISMATCH' };
      }
      // 2. Who the event claims to be for must match who we created the intent for.
      if (userId && intent.userId !== userId) {
        logger.warn({ reference }, 'Deposit webhook rejected: user does not match intent');
        return { handled: false, reason: 'USER_MISMATCH' };
      }
      // 3. Exact amount verification — BigInt comparison, no floats anywhere.
      if (intent.amountMinorUnits !== webhookAmount) {
        logger.warn({ reference }, 'Deposit webhook rejected: amount does not match intent');
        return { handled: false, reason: 'AMOUNT_MISMATCH' };
      }
      // 4. Currency must line up on the event, the intent and the wallet.
      const wallet = await tx.wallet.findUnique({ where: { id: intent.walletId } });
      if (!wallet || wallet.currency !== intent.currency || (currency && currency !== intent.currency)) {
        logger.warn({ reference }, 'Deposit webhook rejected: currency does not match wallet/intent');
        return { handled: false, reason: 'CURRENCY_MISMATCH' };
      }

      // 5. Credit from the intent, durably. The unique gatewayReference index
      //    makes a concurrent duplicate delivery fail with P2002 (caught below),
      //    so the wallet is credited at most once either way.
      const txRecord = await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: 'DEPOSIT',
          amountMinorUnits: intent.amountMinorUnits,
          gateway,
          gatewayReference: reference,
          status: 'COMPLETED'
        }
      });

      await tx.wallet.update({
        where: { id: wallet.id },
        data: { balanceMinorUnits: { increment: intent.amountMinorUnits } }
      });

      await tx.depositIntent.update({
        where: { id: intent.id },
        data: { status: 'COMPLETED', appliedAt: new Date() }
      });

      logger.info({ reference, gateway }, 'Deposit webhook processed against stored intent');
      return { handled: true, alreadyApplied: false, intent, transaction: txRecord };
    });
  } catch (error) {
    if (error.code === 'P2002') {
      // A concurrent delivery won the race; the ledger already has this credit.
      logger.info({ reference, gateway }, 'Deposit webhook ignored: already applied (concurrent duplicate)');
      return { handled: false, alreadyApplied: true };
    }
    logger.error({ error, reference, gateway }, 'Failed to process deposit webhook');
    throw error;
  }
};

/**
 * Request a withdrawal (reserves funds in the same transaction that creates
 * the pending request).
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

  // Only eligible accounts may move money out (own funds are returned on
  // deposit, but funds leaving the platform require verified identity).
  await assertEligibleForMoney(prisma, userId);

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
