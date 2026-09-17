import cron from 'node-cron';
import prisma from '../utils/db.js';
import logger from '../utils/logger.js';

// A PENDING intent older than this is treated as a payment that never arrived
// (checkout abandoned / webhook lost). It is parked as FAILED so dangling
// intents stop accumulating; a provider webhook that arrives LATER against the
// intent still credits normally (the intent-status CAS makes any double
// application impossible), flipping it back to COMPLETED.
export const STALE_DEPOSIT_HOURS = 24;

let isSweeping = false;

const DEPOSIT_CREDIT_KEY = (reference) => `deposit:credit:${reference}`;

/**
 * Reconciliation sweep for deposits.
 *
 * 1. MISSED-WEBHOOK handling: stale PENDING intents are parked as FAILED.
 *    This is lifecycle bookkeeping, not an accounting mutation — nothing was
 *    ever credited, so no ledger record exists to touch.
 *
 * 2. INTEGRITY checks against the plan's financial exit invariant "every
 *    confirmed deposit has exactly one credit":
 *      - a COMPLETED intent must have exactly one ledger DEPOSIT_CREDIT
 *        posting (committed atomically with the intent CAS);
 *      - a non-COMPLETED intent must have NO credit at all.
 *    Violations are logged as critical alerts and NEVER auto-repaired (the
 *    financial domain explicitly forbids silent repair).
 *
 * Returns a summary object so tests can assert on it without parsing logs.
 */
export const reconcileDeposits = async () => {
  if (isSweeping) return null;
  isSweeping = true;

  try {
    const staleBefore = new Date(Date.now() - STALE_DEPOSIT_HOURS * 60 * 60 * 1000);

    // --- 1. Missed webhooks: park stale PENDING intents as FAILED -----------
    const missed = await prisma.depositIntent.updateMany({
      where: { status: 'PENDING', createdAt: { lt: staleBefore } },
      data: { status: 'FAILED' }
    });

    // --- 2. Integrity: every terminal intent keeps exactly one credit --------
    const intents = await prisma.depositIntent.findMany({
      where: { status: { in: ['COMPLETED', 'FAILED'] } },
      select: {
        id: true,
        userId: true,
        reference: true,
        amountMinorUnits: true,
        status: true
      }
    });

    const anomalies = [];

    for (const intent of intents) {
      if (intent.status === 'COMPLETED') {
        const ledger = await prisma.ledgerTransaction.findUnique({
          where: { idempotencyKey: DEPOSIT_CREDIT_KEY(intent.reference) },
          include: { entries: true }
        });
        if (!ledger || ledger.type !== 'DEPOSIT_CREDIT') {
          anomalies.push({
            intentId: intent.id,
            check: 'ledgerPostingMissing',
            reference: intent.reference
          });
        } else {
          const availableEntry = await prisma.ledgerEntry.findFirst({
            where: {
              transactionId: ledger.id,
              account: { userId: intent.userId, type: 'PLAYER_AVAILABLE' }
            }
          });
          if (
            !availableEntry ||
            availableEntry.amountMinorUnits !== intent.amountMinorUnits
          ) {
            anomalies.push({
              intentId: intent.id,
              check: 'ledgerAmount',
              expected: intent.amountMinorUnits.toString(),
              reference: intent.reference
            });
          }
        }
      } else {
        // FAILED intent: money must never have been booked.
        const ledger = await prisma.ledgerTransaction.findUnique({
          where: { idempotencyKey: DEPOSIT_CREDIT_KEY(intent.reference) }
        });
        if (ledger) {
          anomalies.push({
            intentId: intent.id,
            check: 'failedIntentHasCredit',
            reference: intent.reference
          });
        }
      }
    }

    for (const anomaly of anomalies) {
      logger.error({ anomaly }, 'CRITICAL deposit reconciliation anomaly — manual review required');
    }

    if (missed.count > 0) {
      logger.info({ missedCount: missed.count }, 'Parked stale PENDING deposit intents as FAILED');
    }

    return {
      staleParked: missed.count,
      intentsChecked: intents.length,
      anomalies
    };
  } catch (err) {
    logger.error({ err }, 'Error during deposit reconciliation sweep');
    return null;
  } finally {
    isSweeping = false;
  }
};

export const startDepositReconciliationSweep = () => {
  // Run every 5 minutes
  cron.schedule('*/5 * * * *', () => {
    reconcileDeposits();
  });
  logger.info('Deposit reconciliation sweep started');
};