import crypto from 'crypto';
import prisma from '../../utils/db.js';
import logger from '../../utils/logger.js';

const hashBody = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

export const makeDedupeKey = ({ provider, providerEventId, providerReference }) =>
  [provider, providerReference || providerEventId || 'unknown'].filter(Boolean).join(':').slice(0, 255);

export async function recordWebhookReceived({ provider, rawBody, signatureValid, providerEventId, providerReference, eventType }) {
  const dedupeKey = makeDedupeKey({ provider, providerEventId, providerReference });
  try {
    await prisma.paymentWebhookEvent.create({
      data: {
        provider,
        dedupeKey,
        providerReference,
        providerEventId,
        eventType,
        signatureValid,
        payloadHash: hashBody(rawBody),
        processingStatus: 'RECEIVED'
      }
    });
  } catch (error) {
    logger.warn({ error, provider, dedupeKey }, 'Webhook receipt already recorded (duplicate) or not storable');
  }
  return dedupeKey;
}

export async function recordWebhookResult({ provider, dedupeKey, processingStatus, errorCode }) {
  if (!dedupeKey) return;
  try {
    await prisma.paymentWebhookEvent.updateMany({
      where: { provider, dedupeKey, processingStatus: 'RECEIVED' },
      data: { processingStatus, errorCode, processedAt: new Date() }
    });
  } catch (error) {
    logger.warn({ error, provider, dedupeKey }, 'Failed to finalize webhook processing status');
  }
}