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

/// Long enough for any legitimate reference, short enough that a caller cannot
/// push unbounded text into the dedupe key and the audit columns.
const MAX_REFERENCE_LENGTH = 128;

/**
 * Identifies one logical delivery so a repeat can be recognised.
 *
 * Built from the reference and event type only. Including the body hash looked
 * stricter but was weaker in practice: any re-serialisation by the provider or a
 * proxy yields a different hash and defeats the retry, while a caller supplying
 * an arbitrary reference gets a fresh key per request and can therefore grow the
 * table without bound. This shape collapses unidentified garbage onto a single
 * key, exactly as the payment webhooks do.
 */
export const makeVerificationDedupeKey = ({ provider, providerReference, eventType }) =>
  [provider, providerReference || 'unknown', eventType || 'unknown'].join(':').slice(0, 255);

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
    // A collision means we have seen this logical delivery before. It is not a
    // reason to skip the work: the state transition in applyVerificationResult
    // is what makes re-applying harmless, and short-circuiting here is what
    // turned a single transient failure into a permanently lost verdict.
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

  // express.raw only parses application/json, so anything else -- a missing or
  // unexpected content type -- leaves no body to hash. That is a malformed
  // delivery, not a server fault, and it must not be able to raise an
  // unauthenticated 500 on this route.
  const rawBody = Buffer.isBuffer(req.body) ? req.body : null;
  if (!rawBody) {
    logger.warn({ provider }, 'Dojah webhook had no readable JSON body');
    return res.status(400).send('Bad Request');
  }
  const payloadHash = crypto.createHash('sha256').update(rawBody).digest('hex');

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).send('Bad Request');
  }
  if (!payload || typeof payload !== 'object') {
    return res.status(400).send('Bad Request');
  }

  const reference = payload.reference_id;
  const providerReference =
    typeof reference === 'string' && reference.length > 0 && reference.length <= MAX_REFERENCE_LENGTH
      ? reference
      : null;
  const eventType =
    typeof payload.event === 'string'
      ? payload.event
      : typeof payload.verification_status === 'string'
        ? payload.verification_status
        : null;

  // The signature is the only authentication on this route, so it is verified
  // before anything is acted on. An unconfigured secret fails closed inside the
  // adapter.
  const adapter = new DojahKycProvider();
  if (!adapter.verifyWebhookSignature(rawBody, req.headers['x-dojah-signature'])) {
    logger.warn({ provider, providerReference, eventType }, 'Invalid Dojah webhook signature');
    return res.status(401).send('Unauthorized');
  }

  if (!providerReference) {
    logger.warn({ provider }, 'Dojah webhook carried no usable reference_id');
    return res.status(400).send('Bad Request');
  }

  const { dedupeKey, isDuplicate } = await recordWebhookReceived({
    provider,
    dedupeKey: makeVerificationDedupeKey({ provider, providerReference, eventType }),
    providerReference,
    eventType,
    signatureValid: true,
    payloadHash
  });
  if (isDuplicate) {
    logger.debug?.({ provider, providerReference }, 'Repeat Dojah delivery; re-applying idempotently');
  }

  try {
    // The payload already carries the outcome, so it is mapped directly rather
    // than re-fetched. Still in flight: acknowledge and wait for the next one.
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
    // A 5xx asks Dojah to resend. The row is left re-armable: finalize only
    // advances rows still in RECEIVED, and the next attempt is applied rather
    // than discarded as a duplicate, so one transient failure is not terminal.
    logger.error({ error, provider, providerReference }, 'Failed to apply Dojah webhook');
    await finalize(provider, dedupeKey, 'FAILED', 'APPLY_FAILED');
    return res.status(500).send('Internal Server Error');
  }
});

export default verificationWebhookRouter;