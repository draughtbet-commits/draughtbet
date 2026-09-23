import express from 'express';
import { processDepositWebhook, parseDecimalMajorToMinor } from '../wallet/service.js';
import { PaystackGateway } from './PaystackGateway.js';
import { FlutterwaveGateway } from './FlutterwaveGateway.js';
import { WithdrawalService } from '../withdrawal/service.js';
import { recordWebhookReceived, recordWebhookResult } from './webhookEventLog.js';
import logger from '../../utils/logger.js';

export const webhookRouter = express.Router();

const paystackGateway = new PaystackGateway();
const flutterwaveGateway = new FlutterwaveGateway();
// Payout webhook handling only reports a result (no provider calls), but the
// two real gateways are injected for an honest wiring.
const withdrawalService = new WithdrawalService({
  providers: { PAYSTACK: paystackGateway, FLUTTERWAVE: flutterwaveGateway }
});

// Webhooks must use raw body parsing to verify signatures exactly
webhookRouter.use(express.raw({ type: 'application/json' }));

// Every verified webhook is recorded as a PaymentWebhookEvent forensic row on
// entry (RECEIVED) and finalized with the processing outcome below. The row is
// written best-effort only — a storage failure must never block the money
// path — and the unique dedupeKey makes a redelivered webhook a single row.
// Post-credit events are derived from the DURABLE ledger record returned by
// the service, never from the raw webhook body, and only fire for a newly
// applied webhook — a duplicate delivery is acknowledged but emits nothing.
// The durable DepositIntent COMPLETED transition, ledger mirror, outbox rows
// (wallet.updated + notification) are all written by the service in the same
// transaction; the socket push is the outbox drainer's job, never inline here.
const handleDepositResult = async (res, result, userId) => {
  if (result.handled && !result.alreadyApplied) {
    return { status: 'PROCESSED' };
  }

  if (result.alreadyApplied) {
    logger.info('Deposit webhook already applied (duplicate) — acknowledged without re-credit');
    return { status: 'IGNORED_DUPLICATE' };
  }

  logger.warn({ reason: result.reason }, 'Deposit webhook acknowledged without credit');
  return { status: 'REJECTED', errorCode: result.reason };
};

const respond = (res, outcome) =>
  res.status(outcome?.status === 'INVALID_SIGNATURE' ? 401 : 200).send('OK');

const finalize = async ({ provider, dedupeKey }, outcome) =>
  recordWebhookResult({ provider, dedupeKey, processingStatus: outcome.status, errorCode: outcome.errorCode });

webhookRouter.post('/paystack', async (req, res) => {
  let dedupeKey;
  let providerReference;
  try {
    const signature = req.headers['x-paystack-signature'];
    const rawBody = req.body; // This is a Buffer because of express.raw

    const payload = JSON.parse(rawBody.toString('utf8'));
    providerReference = payload.data?.reference;
    const eventType = payload.event;

    if (!paystackGateway.verifyWebhookSignature(rawBody, signature)) {
      logger.warn('Invalid Paystack webhook signature');
      dedupeKey = await recordWebhookReceived({
        provider: 'PAYSTACK',
        providerEventId: eventType,
        providerReference,
        eventType,
        signatureValid: false,
        rawBody
      });
      await finalize({ provider: 'PAYSTACK', dedupeKey }, { status: 'REJECTED', errorCode: 'INVALID_SIGNATURE' });
      return respond(res, { status: 'INVALID_SIGNATURE' });
    }

    dedupeKey = await recordWebhookReceived({
      provider: 'PAYSTACK',
      providerEventId: eventType,
      providerReference,
      eventType,
      signatureValid: true,
      rawBody
    });

    if (payload.event === 'charge.success') {
      const data = payload.data;
      const reference = data.reference;
      // Paystack sends the amount in kobo — already our minor units. The
      // service parses it canonically and compares it against the intent.
      const userId = data.metadata?.userId;

      if (!userId) {
        logger.error({ reference }, 'Paystack webhook payload missing userId in metadata');
        await finalize({ provider: 'PAYSTACK', dedupeKey }, { status: 'REJECTED', errorCode: 'MISSING_USER_ID' });
        return res.status(400).send('Missing userId in metadata');
      }

      const result = await processDepositWebhook({
        reference,
        amountMinorUnits: data.amount,
        currency: data.currency,
        gateway: 'PAYSTACK',
        userId
      });

      const outcome = await handleDepositResult(res, result, userId);
      await finalize({ provider: 'PAYSTACK', dedupeKey }, outcome);
      return respond(res, outcome);
    }

    if (payload.event?.startsWith('transfer.')) {
      // Payout transfer events. Only a PROCESSING withdrawal transitions; a
      // duplicated terminal callback is acknowledged without any money move.
      await withdrawalService.handlePayoutCallback({
        gateway: 'PAYSTACK',
        eventType: payload.event,
        data: payload.data
      });
      await finalize({ provider: 'PAYSTACK', dedupeKey }, { status: 'PROCESSED' });
      return respond(res, { status: 'PROCESSED' });
    }

    await finalize({ provider: 'PAYSTACK', dedupeKey }, { status: 'PROCESSED' });
    respond(res, { status: 'PROCESSED' });
  } catch (error) {
    logger.error({ error }, 'Paystack webhook error');
    await recordWebhookResult({
      provider: 'PAYSTACK',
      dedupeKey,
      processingStatus: 'FAILED',
      errorCode: 'INTERNAL_ERROR'
    });
    res.status(500).send('Internal Server Error');
  }
});

webhookRouter.post('/flutterwave', async (req, res) => {
  let dedupeKey;
  let providerReference;
  try {
    const signature = req.headers['verif-hash'];
    const rawBody = req.body;

    const payload = JSON.parse(rawBody.toString('utf8'));
    providerReference = payload.data?.tx_ref;
    const eventType = payload.event;

    if (!flutterwaveGateway.verifyWebhookSignature(rawBody, signature)) {
      logger.warn('Invalid Flutterwave webhook signature');
      dedupeKey = await recordWebhookReceived({
        provider: 'FLUTTERWAVE',
        providerEventId: eventType,
        providerReference,
        eventType,
        signatureValid: false,
        rawBody
      });
      await finalize({ provider: 'FLUTTERWAVE', dedupeKey }, { status: 'REJECTED', errorCode: 'INVALID_SIGNATURE' });
      return respond(res, { status: 'INVALID_SIGNATURE' });
    }

    dedupeKey = await recordWebhookReceived({
      provider: 'FLUTTERWAVE',
      providerEventId: eventType,
      providerReference,
      eventType,
      signatureValid: true,
      rawBody
    });

    if (payload.event === 'charge.completed' && payload.data.status === 'successful') {
      const data = payload.data;
      const reference = data.tx_ref;
      // Flutterwave sends amount in major units; convert to minor units with
      // exact string math — never Number() * 100 (FP drift). If the value is
      // malformed the intent amount comparison rejects the event anyway.
      const amountMinorUnits = parseDecimalMajorToMinor(data.amount);
      const userId = data.meta?.userId;

      if (!userId) {
        logger.error({ reference }, 'Flutterwave webhook payload missing userId in meta');
        await finalize({ provider: 'FLUTTERWAVE', dedupeKey }, { status: 'REJECTED', errorCode: 'MISSING_USER_ID' });
        return res.status(400).send('Missing userId in meta');
      }

      const result = await processDepositWebhook({
        reference,
        amountMinorUnits,
        currency: data.currency,
        gateway: 'FLUTTERWAVE',
        userId
      });

      const outcome = await handleDepositResult(res, result, userId);
      await finalize({ provider: 'FLUTTERWAVE', dedupeKey }, outcome);
      return respond(res, outcome);
    }

    if (payload.event?.startsWith('transfer.')) {
      await withdrawalService.handlePayoutCallback({
        gateway: 'FLUTTERWAVE',
        eventType: payload.event,
        data: payload.data
      });
      await finalize({ provider: 'FLUTTERWAVE', dedupeKey }, { status: 'PROCESSED' });
      return respond(res, { status: 'PROCESSED' });
    }

    await finalize({ provider: 'FLUTTERWAVE', dedupeKey }, { status: 'PROCESSED' });
    respond(res, { status: 'PROCESSED' });
  } catch (error) {
    logger.error({ error }, 'Flutterwave webhook error');
    await recordWebhookResult({
      provider: 'FLUTTERWAVE',
      dedupeKey,
      processingStatus: 'FAILED',
      errorCode: 'INTERNAL_ERROR'
    });
    res.status(500).send('Internal Server Error');
  }
});

export default webhookRouter;