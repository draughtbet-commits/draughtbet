import crypto from 'crypto';
import prisma from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { postDepositCredit, getLedgerTransactions, getUserLedgerProjections } from '../../services/ledgerService.js';
import { enqueueWalletUpdated, enqueueNotificationDelivery } from '../../services/outboxService.js';
import { recordDailyUsage } from '../../services/dailyUsageService.js';

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
 *
 * A client `clientIdempotencyKey` (from the Idempotency-Key header) is stored
 * on the intent so a replayed checkout resolves to this same row — the replay
 * lookup lives in the controller BEFORE the provider is ever contacted.
 */
export const createDepositIntent = async (userId, amountMinorUnits, gateway, email, clientIdempotencyKey, quoteId = null) => {
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
    // NGN is the launch currency; a GBP wallet must never be credited in kobo.
    if (wallet.currency !== 'NGN') {
      const error = new Error('Deposits are only supported for NGN wallets');
      error.name = 'UnsupportedCurrencyError';
      throw error;
    }

    // When the client quoted first, the quote is claimed inside THIS
    // transaction: ownership, expiry, the quoted amount and the chosen gateway
    // are all re-checked, and the claim is what makes one quote open at most one
    // checkout. A quote can therefore never be reused for a second deposit, nor
    // can the amount drift away from the fee the player was shown.
    let claimedQuote = null;
    if (quoteId) {
      claimedQuote = await claimDepositQuote(tx, { userId, quoteId, amountMinorUnits: amount, gateway });
    }

    const intent = await tx.depositIntent.create({
      data: {
        userId,
        walletId: wallet.id,
        gateway,
        reference,
        amountMinorUnits: amount,
        currency: wallet.currency,
        ...(clientIdempotencyKey !== undefined && clientIdempotencyKey !== null
          ? { clientIdempotencyKey }
          : {})
      }
    });

    if (claimedQuote) {
      // Ties the consumed quote to the intent it opened, so a quote's fate is
      // always traceable from the intent row.
      await tx.depositQuote.update({
        where: { id: claimedQuote.quote.id },
        data: { consumedByIntentId: intent.id }
      });
    }

    return intent;
  });
};

/**
 * Replay lookup for a deposit create carrying a client Idempotency-Key. Returns
 * the original intent when the key was used before, null otherwise.
 *
 * A FAILED intent is deliberately NOT replayable. The enum documents it as
 * "provider initiation reported an error; no checkout was exposed", so there is
 * no checkout to hand back — replaying it returned `authorizationUrl: null` and
 * left the client permanently stuck on that quote with "secure checkout is not
 * available". Retrying after a provider outage has to be able to start over, so
 * the dead row releases its key and the caller creates a fresh intent.
 */
export const findDepositIntentByClientKey = async (userId, clientIdempotencyKey) => {
  if (clientIdempotencyKey === undefined || clientIdempotencyKey === null) return null;
  const intent = await prisma.depositIntent.findUnique({
    where: { userId_clientIdempotencyKey: { userId, clientIdempotencyKey } }
  });
  if (!intent) return null;
  if (intent.status !== 'FAILED') return intent;

  // Retire the key on the dead row instead of deleting it: the intent stays
  // queryable for support and the ledger, but the unique key is free for the
  // retry.
  await prisma.depositIntent.update({
    where: { id: intent.id },
    data: { clientIdempotencyKey: `${clientIdempotencyKey}:superseded:${intent.id}` }
  });
  return null;
};

/**
 * Single deposit intent for the requesting owner. Returns null when the intent
 * does not exist; the caller enforces ownership.
 *
 * Accepts EITHER the intent id or the server-generated provider reference: the
 * Flutter client only ever holds the reference (it is what the provider echoes
 * back and what the user reads in their history), so resolving by id alone
 * would 404 every status poll. Both lookups are ownership-checked.
 */
export const getDepositIntent = async (userId, depositIdOrReference) => {
  const key = String(depositIdOrReference ?? '').trim();
  if (!key) return null;
  const intent =
    (await prisma.depositIntent.findUnique({ where: { id: key } })) ??
    (await prisma.depositIntent.findUnique({ where: { reference: key } }));
  if (!intent || intent.userId !== userId) return null;
  return intent;
};

// ---------------------------------------------------------------------------
// Deposit quotes
// ---------------------------------------------------------------------------

// Gateway descriptors are a server-owned catalogue. The client renders whatever
// list the quote carries and must never hardcode a gateway, a fee or a currency.
const GATEWAY_CATALOGUE = Object.freeze({
  PAYSTACK: Object.freeze({ id: 'paystack', label: 'Paystack', description: 'Card, bank transfer and USSD' }),
  FLUTTERWAVE: Object.freeze({ id: 'flutterwave', label: 'Flutterwave', description: 'Card, bank transfer and mobile money' })
});

/**
 * Basis-point fee, rounded UP. Rounding down would quietly charge the player
 * less than the quote promised, so the rounding direction favours the quote
 * being reproducible rather than being small.
 */
const applyBps = (amount, bps) => {
  const basis = BigInt(bps);
  if (basis <= 0n) return 0n;
  return (amount * basis + 9999n) / 10000n;
};

export class DepositQuoteError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DepositQuoteError';
    this.code = code;
  }
}

const depositQuoteFailure = (message, code) => {
  throw new DepositQuoteError(message, code);
};

/**
 * Reads the deposit policy off the settings singleton. The singleton is
 * seeded at boot, so a missing row is a configuration fault, not a client one.
 */
const readDepositPolicy = async (tx = prisma) => {
  const settings = await tx.platformSettings.findUnique({ where: { id: 'singleton' } });
  if (!settings) {
    depositQuoteFailure('Platform settings not configured', 'POLICY_UNAVAILABLE');
  }
  return settings;
};

/**
 * Issues a server-owned deposit quote: the amount bounds, the currency, the
 * per-gateway fee, the total and the enabled gateway list are all decided here.
 * A client `Idempotency-Key` makes a replayed quote request resolve to this
 * same row, so the client can retry a quote without inventing a second one.
 */
export const createDepositQuote = async (userId, amountMinorUnits, clientIdempotencyKey) => {
  const amount = parseMinorUnits(amountMinorUnits);
  if (amount === null) {
    depositQuoteFailure('Invalid amount', 'INVALID_AMOUNT');
  }

  const settings = await readDepositPolicy();
  if (amount < settings.depositMinP || amount > settings.depositMaxP) {
    depositQuoteFailure('Deposit amount is outside the allowed range', 'AMOUNT_OUT_OF_RANGE');
  }

  // Only NGN is launch-supported; a GBP wallet must never be quoted in kobo.
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  if (!wallet) {
    depositQuoteFailure(`Wallet not found for userId ${userId}`, 'WALLET_NOT_FOUND');
  }
  if (wallet.currency !== 'NGN') {
    depositQuoteFailure('Deposits are only supported for NGN wallets', 'UNSUPPORTED_CURRENCY');
  }

  const enabled = [
    { gateway: 'PAYSTACK', on: settings.paystackEnabled, bps: settings.paystackFeeBps },
    { gateway: 'FLUTTERWAVE', on: settings.flutterwaveEnabled, bps: settings.flutterwaveFeeBps }
  ].filter((entry) => entry.on);

  if (enabled.length === 0) {
    depositQuoteFailure('No deposit gateway is currently available', 'NO_GATEWAY_AVAILABLE');
  }

  // FAIL CLOSED on a non-zero fee. The deposit credit path charges and credits
  // `intent.amountMinorUnits` and nothing else, so a fee quoted here would be
  // displayed to the player but never actually collected — the checkout would
  // take ₦1,000 while the UI promised ₦1,025. Refusing to quote is the only
  // honest option until the fee is posted as platform revenue on the credit
  // path. Fees therefore stay at 0 bps, which is the launch default anyway.
  if (enabled.some((entry) => BigInt(entry.bps) !== 0n)) {
    logger.error(
      { paystackFeeBps: settings.paystackFeeBps, flutterwaveFeeBps: settings.flutterwaveFeeBps },
      'Refusing to quote: a non-zero gateway fee is configured but the deposit credit path does not collect it'
    );
    depositQuoteFailure(
      'A gateway fee is configured but cannot be collected yet',
      'FEE_SCHEDULE_NOT_ACTIVE'
    );
  }

  // The quote's headline figures are the cheapest available route: the client
  // shows one total before the player picks a gateway, and each method carries
  // its own fee so a more expensive choice is still visible and honest.
  const methods = enabled.map((entry) => {
    const meta = GATEWAY_CATALOGUE[entry.gateway];
    const fee = applyBps(amount, BigInt(entry.bps));
    return { id: meta.id, label: meta.label, description: meta.description, feeMinorUnits: fee.toString() };
  });
  const headlineFee = methods.reduce(
    (lowest, method) => (BigInt(method.feeMinorUnits) < lowest ? BigInt(method.feeMinorUnits) : lowest),
    methods[0] ? BigInt(methods[0].feeMinorUnits) : 0n
  );
  const total = amount + headlineFee;

  const ttlSeconds = Number(settings.depositQuoteTtlSeconds) > 0 ? Number(settings.depositQuoteTtlSeconds) : 900;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  return await prisma.$transaction(async (tx) => {
    if (clientIdempotencyKey !== undefined && clientIdempotencyKey !== null) {
      // Re-read inside the transaction so a concurrent replay of the same key
      // resolves to the winner's row instead of racing it to a second quote.
      const replay = await tx.depositQuote.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey: clientIdempotencyKey } }
      });
      if (replay) return { quote: replay, replayed: true };
    }
    const quote = await tx.depositQuote.create({
      data: {
        userId,
        amountMinorUnits: amount,
        currency: wallet.currency,
        feeMinorUnits: headlineFee,
        totalMinorUnits: total,
        paymentMethods: methods,
        expiresAt,
        ...(clientIdempotencyKey !== undefined && clientIdempotencyKey !== null
          ? { idempotencyKey: clientIdempotencyKey }
          : {})
      }
    });
    return { quote, replayed: false };
  });
};

/**
 * Replay lookup for a quote create carrying a client Idempotency-Key.
 */
export const findDepositQuoteByClientKey = async (userId, clientIdempotencyKey) => {
  if (clientIdempotencyKey === undefined || clientIdempotencyKey === null) return null;
  return await prisma.depositQuote.findUnique({
    where: { userId_idempotencyKey: { userId, idempotencyKey: clientIdempotencyKey } }
  });
};

/**
 * Wire shape for a quote. Money is always a string of integer minor units —
 * never a JSON number, so a BigInt can never lose precision in transit.
 */
export const depositQuotePayload = (quote) => {
  const methods = Array.isArray(quote.paymentMethods) ? quote.paymentMethods : [];
  return {
    id: quote.id,
    amountMinorUnits: quote.amountMinorUnits.toString(),
    currency: quote.currency,
    feeMinorUnits: quote.feeMinorUnits.toString(),
    totalMinorUnits: quote.totalMinorUnits.toString(),
    paymentMethods: methods.map((method) => ({
      id: method.id,
      label: method.label,
      description: method.description ?? null,
      feeMinorUnits: String(method.feeMinorUnits ?? '0')
    })),
    idempotencyKey: quote.idempotencyKey ?? null,
    status: quote.status,
    expiresAt: quote.expiresAt,
    createdAt: quote.createdAt
  };
};

/**
 * Claims a quote for an intent INSIDE the intent's own transaction.
 *
 * The conditional `updateMany` on (id, status=ACTIVE) is the exactly-once gate:
 * a concurrent second intent for the same quote matches zero rows and is
 * rejected, so one quote can never open two provider checkouts. Ownership,
 * expiry and the quoted amount are all re-checked here — the client cannot
 * change the amount after seeing the fee and still reuse the quote.
 */
export const claimDepositQuote = async (tx, { userId, quoteId, amountMinorUnits, gateway }) => {
  const quote = await tx.depositQuote.findUnique({ where: { id: quoteId } });
  if (!quote || quote.userId !== userId) {
    depositQuoteFailure('Deposit quote not found', 'QUOTE_NOT_FOUND');
  }
  if (quote.status === 'CONSUMED') {
    depositQuoteFailure('Deposit quote has already been used', 'QUOTE_ALREADY_USED');
  }
  if (quote.status === 'EXPIRED' || quote.expiresAt.getTime() <= Date.now()) {
    depositQuoteFailure('Deposit quote has expired', 'QUOTE_EXPIRED');
  }
  if (quote.amountMinorUnits !== amountMinorUnits) {
    depositQuoteFailure('Deposit amount does not match the quote', 'QUOTE_AMOUNT_MISMATCH');
  }
  const methods = Array.isArray(quote.paymentMethods) ? quote.paymentMethods : [];
  const method = methods.find((entry) => entry.id === gateway.toLowerCase());
  if (!method) {
    depositQuoteFailure('Selected payment method is not available for this quote', 'QUOTE_METHOD_UNAVAILABLE');
  }

  const claimed = await tx.depositQuote.updateMany({
    where: { id: quoteId, status: 'ACTIVE' },
    data: { status: 'CONSUMED', consumedAt: new Date() }
  });
  if (claimed.count !== 1) {
    // Lost the race to a concurrent intent on the same quote.
    depositQuoteFailure('Deposit quote has already been used', 'QUOTE_ALREADY_USED');
  }
  return { quote: { ...quote, status: 'CONSUMED' }, method };
};

/**
 * Sweeps ACTIVE quotes past their expiry so the table cannot grow without
 * bound. Idempotent and restart-safe: it is a plain bounded UPDATE.
 */
export const expireDepositQuotes = async (now = new Date()) => {
  const result = await prisma.depositQuote.updateMany({
    where: { status: 'ACTIVE', expiresAt: { lte: now } },
    data: { status: 'EXPIRED' }
  });
  return result.count;
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
      // The stored intent is the only reference that can authorize a credit.
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
      if (userId && intent.userId !== userId) {
        logger.warn({ reference }, 'Deposit webhook rejected: user does not match intent');
        return { handled: false, reason: 'USER_MISMATCH' };
      }
      // Exact BigInt comparison — no floats anywhere.
      if (intent.amountMinorUnits !== webhookAmount) {
        logger.warn({ reference }, 'Deposit webhook rejected: amount does not match intent');
        return { handled: false, reason: 'AMOUNT_MISMATCH' };
      }
      const wallet = await tx.wallet.findUnique({ where: { id: intent.walletId } });
      if (!wallet || wallet.currency !== intent.currency || (currency && currency !== intent.currency)) {
        logger.warn({ reference }, 'Deposit webhook rejected: currency does not match wallet/intent');
        return { handled: false, reason: 'CURRENCY_MISMATCH' };
      }

      // CAS gate: only an intent that has never been credited transitions to
      // COMPLETED. PENDING wins the credit; a FAILED intent (stale sweep parked
      // a payment that actually arrived late) may still be legitimately credited
      // exactly once. A concurrent duplicate sees COMPLETED, matches 0 rows and
      // is reported as already applied — the clock is irrelevant, the state is.
      const { count } = await tx.depositIntent.updateMany({
        where: { id: intent.id, status: { in: ['PENDING', 'FAILED'] } },
        data: { status: 'COMPLETED', appliedAt: new Date() }
      });
      if (count !== 1) {
        logger.info({ reference }, 'Deposit webhook ignored: already applied (concurrent duplicate)');
        return { handled: false, alreadyApplied: true };
      }

      // Ledger credit idempotent per reference; commits only with the CAS.
      const { transaction: ledgerTx } = await postDepositCredit(tx, {
        userId: intent.userId,
        amountMinorUnits: intent.amountMinorUnits,
        currency: intent.currency,
        depositIntentId: intent.id,
        reference: intent.reference
      });

      // Count the accepted deposit in today's safer-play usage bucket (atomic
      // with the credit; only reachable when the CAS above wins once).
      await recordDailyUsage(tx, {
        userId: intent.userId,
        currency: intent.currency,
        depositCommittedMinorUnits: intent.amountMinorUnits
      });

      // Durable wallet.updated outbox row, atomic with the credit.
      await enqueueWalletUpdated(tx, {
        userId: intent.userId,
        walletId: wallet.id,
        currency: intent.currency,
        type: 'DEPOSIT',
        amountMinorUnits: intent.amountMinorUnits,
        dedupeKey: `wallet:deposit:${intent.id}`
      });

      // 8. Deposit notification + its durable delivery event, atomic with the
      //    credit (the unique [userId, matchId, type] index allows one per
      //    deposit; matchId is NULL here so different deposits never dedup).
      const amountMajor = `${intent.amountMinorUnits / 100n}.${(intent.amountMinorUnits % 100n).toString().padStart(2, '0')}`;
      const depositNotif = await tx.notification.create({
        data: {
          userId: intent.userId,
          type: 'DEPOSIT_CONFIRMED',
          title: 'Deposit Successful',
          message: `Your deposit of ₦${amountMajor} has been credited to your wallet.`,
          link: '/wallet'
        }
      });
      await enqueueNotificationDelivery(tx, depositNotif, {
        dedupeKey: `notify:deposit:${intent.id}`
      });

      logger.info({ reference, gateway }, 'Deposit webhook processed against stored intent');
      return {
        handled: true,
        alreadyApplied: false,
        intent,
        transaction: { id: intent.reference, amountMinorUnits: intent.amountMinorUnits },
        ledgerTransactionId: ledgerTx.id
      };
    });
  } catch (error) {
    logger.error({ error, reference, gateway }, 'Failed to process deposit webhook');
    throw error;
  }
};

export const getWalletBalance = async (userId) => {
  const wallet = await prisma.wallet.findUnique({
    where: { userId },
    select: { currency: true }
  });
  if (!wallet) return null;
  const currency = wallet.currency ?? 'NGN';
  const projections = await getUserLedgerProjections(prisma, userId, currency);
  return {
    currency,
    balanceMinorUnits: projections.available,
    lockedMinorUnits: projections.locked,
    pendingMinorUnits: projections.pending
  };
};

export const getWalletTransactions = async (userId, page = 1, limit = 20) => {
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  if (!wallet) return { transactions: [], total: 0 };

  return getLedgerTransactions(prisma, userId, {
    page,
    limit,
    currency: wallet.currency ?? 'NGN'
  });
};
