import express from 'express';
import { processDepositWebhook, parseDecimalMajorToMinor } from '../wallet/service.js';
import { PaystackGateway } from './PaystackGateway.js';
import { FlutterwaveGateway } from './FlutterwaveGateway.js';
import { WithdrawalService } from '../withdrawal/service.js';
import {
  isWebhookAuthAbuseBlocked,
  recordWebhookInvalidSignature
} from '../../middleware/rateLimit.js';
import logger from '../../utils/logger.js';

export const webhookRouter = express.Router();

const paystackGateway = new PaystackGateway();
const flutterwaveGateway = new FlutterwaveGateway();
// Payout webhook handling only reports a result (no provider calls), but the
// two real gateways are injected for an honest wiring.
const withdrawalService = new WithdrawalService({
  providers: { PAYSTACK: paystackGateway, FLUTTERWAVE: flutterwaveGateway }
});

// Webhooks must use raw body parsing to verify signatures exactly (bounded to 1mb)
webhookRouter.use(express.raw({ type: 'application/json', limit: '1mb' }));

// Post-credit events are derived from the DURABLE ledger record returned by
// the service, never from the raw webhook body, and only fire for a newly
// applied webhook — a duplicate delivery is acknowledged but emits nothing.
// The durable DepositIntent COMPLETED transition, ledger mirror, outbox rows
// (wallet.updated + notification) are all written by the service in the same
// transaction; the socket push is the outbox drainer's job, never inline here.
const handleDepositResult = async (res, result) => {
  if (result.handled && !result.alreadyApplied) {
    return res.status(200).send('OK');
  }

  if (result.alreadyApplied) {
    logger.info('Deposit webhook already applied (duplicate) — acknowledged without re-credit');
    return res.status(200).send('OK');
  }

  logger.warn({ reason: result.reason }, 'Deposit webhook acknowledged without credit');
  return res.status(200).send('OK');
};

const parseWebhookPayload = (rawBody) => {
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
    return { ok: false, error: 'Empty webhook payload' };
  }
  try {
    const parsed = JSON.parse(rawBody.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'Webhook payload must be a JSON object' };
    }
    if (typeof parsed.event !== 'string' || !parsed.event.trim()) {
      return { ok: false, error: 'Webhook payload missing event' };
    }
    return { ok: true, payload: parsed };
  } catch {
    return { ok: false, error: 'Malformed webhook JSON payload' };
  }
};

webhookRouter.post('/paystack', async (req, res) => {
  try {
    if (await isWebhookAuthAbuseBlocked(req, 'paystack')) {
      res.set('Retry-After', '60');
      return res.status(429).send('Too many invalid webhook authentication attempts');
    }

    const signature = req.headers['x-paystack-signature'];
    const rawBody = req.body; // Buffer because of express.raw

    if (!Buffer.isBuffer(rawBody) || !paystackGateway.verifyWebhookSignature(rawBody, signature)) {
      const abuse = await recordWebhookInvalidSignature(req, 'paystack');
      logger.warn(
        {
          event: 'webhook_invalid_signature',
          provider: 'paystack',
          requestId: req.id,
          ip: req.ip,
          invalidHits: abuse.totalHits
        },
        'Invalid Paystack webhook signature'
      );
      if (abuse.blocked) {
        res.set('Retry-After', '60');
        return res.status(429).send('Too many invalid webhook authentication attempts');
      }
      return res.status(401).send('Unauthorized');
    }

    const parsed = parseWebhookPayload(rawBody);
    if (!parsed.ok) {
      logger.warn({ provider: 'paystack', requestId: req.id, reason: parsed.error }, 'Malformed Paystack webhook');
      return res.status(400).send(parsed.error);
    }
    const payload = parsed.payload;

    if (payload.event === 'charge.success') {
      const data = payload.data;
      if (!data || typeof data !== 'object') {
        return res.status(400).send('Missing webhook data object');
      }
      const reference = data.reference;
      // Paystack sends the amount in kobo — already our minor units. The
      // service parses it canonically and compares it against the intent.
      const userId = data.metadata?.userId;

      if (!userId) {
        logger.error({ reference, requestId: req.id }, 'Paystack webhook payload missing userId in metadata');
        return res.status(400).send('Missing userId in metadata');
      }

      const result = await processDepositWebhook({
        reference,
        amountMinorUnits: data.amount,
        currency: data.currency,
        gateway: 'PAYSTACK',
        userId
      });

      await handleDepositResult(res, result);
      return;
    }

    if (payload.event.startsWith('transfer.')) {
      if (!payload.data || typeof payload.data !== 'object') {
        return res.status(400).send('Missing transfer data object');
      }
      // Payout transfer events. Only a PROCESSING withdrawal transitions; a
      // duplicated terminal callback is acknowledged without any money move.
      await withdrawalService.handlePayoutCallback({
        gateway: 'PAYSTACK',
        eventType: payload.event,
        data: payload.data
      });
      return res.status(200).send('OK');
    }

    res.status(200).send('OK');
  } catch (error) {
    logger.error({ error, requestId: req.id }, 'Paystack webhook error');
    res.status(500).send('Internal Server Error');
  }
});

webhookRouter.post('/flutterwave', async (req, res) => {
  try {
    if (await isWebhookAuthAbuseBlocked(req, 'flutterwave')) {
      res.set('Retry-After', '60');
      return res.status(429).send('Too many invalid webhook authentication attempts');
    }

    const signature = req.headers['verif-hash'];
    const rawBody = req.body;

    if (!Buffer.isBuffer(rawBody) || !flutterwaveGateway.verifyWebhookSignature(rawBody, signature)) {
      const abuse = await recordWebhookInvalidSignature(req, 'flutterwave');
      logger.warn(
        {
          event: 'webhook_invalid_signature',
          provider: 'flutterwave',
          requestId: req.id,
          ip: req.ip,
          invalidHits: abuse.totalHits
        },
        'Invalid Flutterwave webhook signature'
      );
      if (abuse.blocked) {
        res.set('Retry-After', '60');
        return res.status(429).send('Too many invalid webhook authentication attempts');
      }
      return res.status(401).send('Unauthorized');
    }

    const parsed = parseWebhookPayload(rawBody);
    if (!parsed.ok) {
      logger.warn({ provider: 'flutterwave', requestId: req.id, reason: parsed.error }, 'Malformed Flutterwave webhook');
      return res.status(400).send(parsed.error);
    }
    const payload = parsed.payload;

    if (payload.event === 'charge.completed') {
      const data = payload.data;
      if (!data || typeof data !== 'object') {
        return res.status(400).send('Missing webhook data object');
      }
      if (data.status === 'successful') {
        const reference = data.tx_ref;
        // Flutterwave sends amount in major units; convert to minor units with
        // exact string math — never Number() * 100 (FP drift). If the value is
        // malformed the intent amount comparison rejects the event anyway.
        const amountMinorUnits = parseDecimalMajorToMinor(data.amount);
        const userId = data.meta?.userId;

        if (!userId) {
          logger.error({ reference, requestId: req.id }, 'Flutterwave webhook payload missing userId in meta');
          return res.status(400).send('Missing userId in meta');
        }

        const result = await processDepositWebhook({
          reference,
          amountMinorUnits,
          currency: data.currency,
          gateway: 'FLUTTERWAVE',
          userId
        });

        await handleDepositResult(res, result);
        return;
      }
    }

    if (payload.event.startsWith('transfer.')) {
      if (!payload.data || typeof payload.data !== 'object') {
        return res.status(400).send('Missing transfer data object');
      }
      await withdrawalService.handlePayoutCallback({
        gateway: 'FLUTTERWAVE',
        eventType: payload.event,
        data: payload.data
      });
      return res.status(200).send('OK');
    }

    res.status(200).send('OK');
  } catch (error) {
    logger.error({ error, requestId: req.id }, 'Flutterwave webhook error');
    res.status(500).send('Internal Server Error');
  }
});
