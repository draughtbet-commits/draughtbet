import crypto from 'crypto';
import express from 'express';
import prisma from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { DojahKycProvider, mapDojahVerification } from './providerAdapter.js';
import { applyVerificationResult } from './service.js';

export const verificationWebhookRouter = express.Router();

// Mounted before the global express.json() so the body stays a raw Buffer —
// HMAC is computed over the exact bytes Dojah signed, and re-serialising a
// parsed object would change them.
verificationWebhookRouter.use(express.raw({ type: 'application/json' }));

const hashBody = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

/**
 * Dedupe key for one delivery.
 *
 * Dojah's payload carries no unique delivery id, so identity is the reference
 * plus the event type plus the body hash. The body hash is what makes this
 * correct for a retried delivery of an unchanged event: same key, recognised
 * as a duplicate. It also keeps two genuinely different events for the same
 * verification distinguishable rather than silently dropping the second.
 */
export const makeVerificationDedupeKey = ({ provider, providerReference, eventType, payloadHash }) =>
  [provider, providerReference || 'unknown', eventType || 'unknown', payloadHash]
    .join(':')
    .slice(0, 255);

const recordWebhookReceived = async ({
  provider,
  dedupeKey,
  providerReference,
  eventType,
  signatureValid,
  payloadHash
}) => {
  try {
    await prisma.verificationWebhookEvent.create({
      data: {
        provider,
        dedupeKey,
        providerReference,
        eventType,
        signatureValid,
        payloadHash,
        processingStatus: 'RECEIVED'
      }
    });
    return { dedupeKey, isDuplicate: false };
  } catch (error) {
    // A unique-collision is a replay, not a failure. Anything else is logged
    // but must not stop us applying the result.
    const isDuplicate = error?.code === 'P2002';
    if (!isDuplicate) {
      logger.error({ error, provider, dedupeKey }, 'Could not record verification webhook');
    }
    return { dedupeKey, isDuplicate };
  }
};

const finalize = async (provider, dedupeKey, processingStatus, errorCode) => {
  if (!dedupeKey) return;
  try {
    await prisma.verificationWebhookEvent.updateMany({
      where: { provider, dedupeKey, processingStatus: 'RECEIVED' },
      data: { processingStatus, errorCode, processedAt: new Date() }
    });
  } catch (error) {
    logger.error({ error, provider, dedupeKey }, 'Failed to finalize verification webhook status');
  }
};

verificationWebhookRouter.post('/dojah', async (req, res) => {
  const provider = 'dojah';
  const payloadHash = hashBody(req.body);

  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).send('Bad Request');
  }

  const providerReference = payload?.reference_id ?? null;
  const eventType = payload?.event ?? payload?.verification_status ?? null;

  // The signature is the only authentication on this route. It is verified
  // before anything is applied, and an unconfigured secret fails closed.
  const adapter = new DojahKycProvider();
  if (!adapter.verifyWebhookSignature(req.body, req.headers['x-dojah-signature'])) {
    logger.warn({ provider, providerReference }, 'Invalid Dojah webhook signature');
    const { dedupeKey } = await recordWebhookReceived({
      provider,
      dedupeKey: makeVerificationDedupeKey({ provider, providerReference, eventType, payloadHash }),
      providerReference,
      eventType,
      signatureValid: false,
      payloadHash
    });
    await finalize(provider, dedupeKey, 'REJECTED', 'INVALID_SIGNATURE');
    return res.status(401).send('Unauthorized');
  }

  if (!providerReference) {
    logger.warn({ provider }, 'Dojah webhook carried no reference_id');
    return res.status(400).send('Bad Request');
  }

  const { dedupeKey, isDuplicate } = await recordWebhookReceived({
    provider,
    dedupeKey: makeVerificationDedupeKey({ provider, providerReference, eventType, payloadHash }),
    providerReference,
    eventType,
    signatureValid: true,
    payloadHash
  });
  if (isDuplicate) {
    // Acknowledge without reprocessing: a non-2xx would make Dojah retry a
    // delivery we have already applied.
    logger.info({ provider, providerReference }, 'Duplicate Dojah webhook ignored');
    return res.status(200).send('OK');
  }

  try {
    // The payload already carries the outcome, so it is mapped directly rather
    // than re-fetched.
    const result = mapDojahVerification(payload);
    if (result.status === 'PENDING') {
      await finalize(provider, dedupeKey, 'PROCESSED');
      logger.info({ provider, providerReference }, 'Dojah webhook reports verification still open');
      return res.status(200).send('OK');
    }
    const caseId = await applyVerificationResult({ providerReference, result });
    if (!caseId) {
      await finalize(provider, dedupeKey, 'IGNORED_DUPLICATE', 'UNKNOWN_REFERENCE');
      return res.status(200).send('OK');
    }
    await finalize(provider, dedupeKey, 'PROCESSED');
    return res.status(200).send('OK');
  } catch (error) {
    // A 5xx asks Dojah to retry, which is what we want for a transient failure.
    // Returning 200 here would silently drop a verification verdict.
    logger.error({ error, provider, providerReference }, 'Failed to apply Dojah webhook');
    await finalize(provider, dedupeKey, 'FAILED', 'APPLY_FAILED');
    return res.status(500).send('Internal Server Error');
  }
});

export default verificationWebhookRouter;