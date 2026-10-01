import prisma from '../utils/db.js';
import logger from '../utils/logger.js';
import {
  auditStakeLocks,
  findStakeLockAuditCandidates,
  reconcileStakeLocks,
} from '../services/lockReconciliation.js';
import cron from 'node-cron';

/**
 * Guards the stake-lock invariant described in `lockReconciliation`.
 *
 * The app shows a player "locked" money straight from `GET /wallet/balance`,
 * which reads `PLAYER_LOCKED`. That number is only trustworthy while the ledger
 * agrees with the live reservations. This sweep is the server-side check that
 * keeps it honest:
 *
 *   audit only (default) -- report every player whose lock disagrees with their
 *                           live reservations. Stranded funds are surfaced, never
 *                           silently rewritten.
 *   repair (opt-in)      -- return stranded locks and close stale rows.
 *
 * Repair stays opt-in because it posts to the ledger: an unattended job that
 * invents balance corrections is worse than an alert. Enable with
 * `STAKE_LOCK_RECONCILE_REPAIR=true`, which is how the dev fixtures self-heal.
 */

const REPAIR_ENABLED = process.env.STAKE_LOCK_RECONCILE_REPAIR === 'true';

export async function processStakeLockSweep({ repair = REPAIR_ENABLED } = {}) {
  const candidates = await findStakeLockAuditCandidates(prisma);
  const outcome = { scanned: candidates.length, mismatched: 0, repaired: 0, errored: 0, strandedMinorUnits: 0n };

  for (const userId of candidates) {
    try {
      const audit = repair
        ? await reconcileStakeLocks(prisma, userId)
        : await auditStakeLocks(prisma, userId);

      if (audit.balanced) continue;

      outcome.mismatched++;
      if (audit.strandedMinorUnits > 0n) outcome.strandedMinorUnits += audit.strandedMinorUnits;

      const detail = {
        userId,
        expectedMinorUnits: audit.expectedMinorUnits.toString(),
        actualMinorUnits: audit.actualMinorUnits.toString(),
        strandedMinorUnits: audit.strandedMinorUnits.toString(),
        staleReservations: audit.staleReservations.length,
      };

      if (repair && audit.strandedMinorUnits > 0n) {
        outcome.repaired++;
        logger.warn(detail, 'Stake lock sweep repaired a stranded lock');
      } else {
        logger.error(detail, 'STAKE LOCK INVARIANT VIOLATED: ledger holds stake with no live reservation');
      }
    } catch (err) {
      outcome.errored++;
      logger.error({ err, userId }, 'Stake lock sweep failed for a player');
    }
  }

  if (outcome.mismatched > 0) {
    logger.warn({ ...outcome, strandedMinorUnits: outcome.strandedMinorUnits.toString() }, 'Stake lock sweep summary');
  }
  return outcome;
}

export const startStakeLockSweep = () => {
  cron.schedule('*/2 * * * *', () => {
    processStakeLockSweep().catch((err) => logger.error({ err }, 'Stake lock sweep crashed'));
  });
  logger.info({ repair: REPAIR_ENABLED }, 'Stake lock reconciliation sweep started');
};