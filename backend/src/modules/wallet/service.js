import crypto from 'crypto';
import prisma from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { postDepositCredit } from '../../services/ledgerService.js';

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

      // 6. V2 ledger mirror in the SAME transaction: credits commit only with
      //    the wallet credit, so a replay or concurrent duplicate can never
      //    leave a wallet credit without its ledger posting (and vice versa).
      const { transaction: ledgerTx } = await postDepositCredit(tx, {
        userId: intent.userId,
        amountMinorUnits: intent.amountMinorUnits,
        currency: intent.currency,
        depositIntentId: intent.id,
        reference: intent.reference
      });

      // 7. Durable wallet.updated outbox row, atomic with the credit.
      await tx.outboxEvent.create({
        data: {
          aggregateType: 'Wallet',
          aggregateId: wallet.id,
          eventType: 'wallet.updated',
          payload: {
            userId: intent.userId,
            walletId: wallet.id,
            currency: intent.currency,
            type: 'DEPOSIT',
            amountMinorUnits: intent.amountMinorUnits.toString()
          }
        }
      });

      // 8. Deposit notification, atomic with the credit (the unique
      //    [userId, matchId, type] index allows one per deposit; matchId is
      //    NULL here so different deposits never dedup into one).
      const amountMajor = `${intent.amountMinorUnits / 100n}.${(intent.amountMinorUnits % 100n).toString().padStart(2, '0')}`;
      await tx.notification.create({
        data: {
          userId: intent.userId,
          type: 'DEPOSIT_CONFIRMED',
          title: 'Deposit Successful',
          message: `Your deposit of ₦${amountMajor} has been credited to your wallet.`,
          link: '/wallet'
        }
      });

      logger.info({ reference, gateway }, 'Deposit webhook processed against stored intent');
      return {
        handled: true,
        alreadyApplied: false,
        intent,
        transaction: txRecord,
        ledgerTransactionId: ledgerTx.id
      };
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
