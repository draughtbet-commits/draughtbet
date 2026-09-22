import cron from 'node-cron';
import prisma from '../utils/db.js';
import logger from '../utils/logger.js';
import { PaystackGateway } from '../modules/payment/PaystackGateway.js';
import { FlutterwaveGateway } from '../modules/payment/FlutterwaveGateway.js';
import { WithdrawalService } from '../modules/withdrawal/service.js';

// Provider payout follow-up: resolves withdrawals stuck in PROCESSING because
// no webhook ever arrived. Every run probes only rows whose provider result is
// due, asks the provider for the authoritative verdict, and funnels the
// terminal outcome through reportPayoutResult (whose atomic CAS means resolving
// a payout twice is always a safe no-op). Money never moves on an ambiguous
// answer: 'processing' just records the check and re-probes later.

// Age (hours) a PROCESSING withdrawal must exceed before the first probe.
export const PAYOUT_FOLLOWUP_AGE_HOURS = clampPositive(process.env.PAYOUT_FOLLOWUP_AGE_HOURS, 6);
// Minimum re-check interval once a withdrawal has been probed.
export const PAYOUT_FOLLOWUP_RECHECK_MS = clampPositive(process.env.PAYOUT_FOLLOWUP_RECHECK_MINUTES, 30) * 60_000;
const MAX_PER_RUN = 10;

function clampPositive(raw, fallback) {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

export const resolveFollowUpThreshold = (now = new Date(), ageHours = PAYOUT_FOLLOWUP_AGE_HOURS) =>
  new Date(now.getTime() - Math.max(1, ageHours) * 60 * 60 * 1000);

const defaultService = new WithdrawalService({
  providers: { PAYSTACK: new PaystackGateway(), FLUTTERWAVE: new FlutterwaveGateway() }
});

export async function processProviderFollowUp({
  service = defaultService,
  now = new Date(),
  maxPerRun = MAX_PER_RUN,
  ageHours = PAYOUT_FOLLOWUP_AGE_HOURS
} = {}) {
  const threshold = resolveFollowUpThreshold(now, ageHours);
  const recheckBefore = new Date(now.getTime() - PAYOUT_FOLLOWUP_RECHECK_MS);

  const stuck = await prisma.withdrawal.findMany({
    where: {
      status: 'PROCESSING',
      processedAt: { not: null, lt: threshold },
      OR: [{ followUpCheckAt: null }, { followUpCheckAt: { lt: recheckBefore } }]
    },
    orderBy: { processedAt: 'asc' },
    take: maxPerRun
  });

  const results = { checked: 0, resolved: 0, pending: 0, errored: 0 };
  for (const withdrawal of stuck) {
    const provider = service.providers?.[withdrawal.gateway];
    if (!provider) {
      logger.warn({ withdrawalId: withdrawal.id, gateway: withdrawal.gateway }, 'Follow-up: no provider configured');
      results.errored++;
      continue;
    }
    try {
      const verdict = await provider.verifyPayoutStatus({
        reference: withdrawal.reference,
        providerRef: withdrawal.providerRef
      });
      if (verdict.status === 'success') {
        await service.reportPayoutResult(withdrawal.id, { success: true });
        results.resolved++;
      } else if (verdict.status === 'failed') {
        await service.reportPayoutResult(withdrawal.id, {
          success: false,
          failureReason: 'Provider reported a failed payout (follow-up sweep)'
        });
        results.resolved++;
      } else {
        await service.noteFollowUpCheck(withdrawal.id);
        results.pending++;
      }
      results.checked++;
    } catch (error) {
      logger.warn({ error, withdrawalId: withdrawal.id }, 'Follow-up verification failed for withdrawal');
      results.errored++;
    }
  }

  if (stuck.length > 0) {
    logger.info({ scanned: stuck.length, ...results }, 'Provider payout follow-up complete');
  }
  return { scanned: stuck.length, ...results };
}

let isSweeping = false;

export const startProviderFollowUp = () => {
  // Every 10 minutes.
  return cron.schedule('*/10 * * * *', async () => {
    if (isSweeping) return;
    isSweeping = true;
    try {
      await processProviderFollowUp();
    } catch (err) {
      logger.error({ err }, 'Provider payout follow-up sweep failed');
    } finally {
      isSweeping = false;
    }
  });
};