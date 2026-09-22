import express from 'express';
import { processDepositWebhook, parseDecimalMajorToMinor } from '../wallet/service.js';
import { PaystackGateway } from './PaystackGateway.js';
import { FlutterwaveGateway } from './FlutterwaveGateway.js';
import { WithdrawalService } from '../withdrawal/service.js';
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

// Post-credit events are derived from the DURABLE ledger record returned by
// the service, never from the raw webhook body, and only fire for a newly
// applied webhook — a duplicate delivery is acknowledged but emits nothing.
// The durable DepositIntent COMPLETED transition, ledger mirror, outbox rows
// (wallet.updated + notification) are all written by the service in the same
// transaction; the socket push is the outbox drainer's job, never inline here.
const handleDepositResult = async (res, result, userId) => {
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

webhookRouter.post('/paystack', async (req, res) => {
  try {
    const signature = req.headers['x-paystack-signature'];
    const rawBody = req.body; // This is a Buffer because of express.raw

    if (!paystackGateway.verifyWebhookSignature(rawBody, signature)) {
      logger.warn('Invalid Paystack webhook signature');
      return res.status(401).send('Unauthorized');
    }

    const payload = JSON.parse(rawBody.toString('utf8'));

    if (payload.event === 'charge.success') {
      const data = payload.data;
      const reference = data.reference;
      // Paystack sends the amount in kobo — already our minor units. The
      // service parses it canonically and compares it against the intent.
      const userId = data.metadata?.userId;

      if (!userId) {
        logger.error({ reference }, 'Paystack webhook payload missing userId in metadata');
        return res.status(400).send('Missing userId in metadata');
      }

      const result = await processDepositWebhook({
        reference,
        amountMinorUnits: data.amount,
        currency: data.currency,
        gateway: 'PAYSTACK',
        userId
      });

      await handleDepositResult(res, result, userId);
      return;
    }

    if (payload.event?.startsWith('transfer.')) {
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
    logger.error({ error }, 'Paystack webhook error');
    res.status(500).send('Internal Server Error');
  }
});

webhookRouter.post('/flutterwave', async (req, res) => {
  try {
    const signature = req.headers['verif-hash'];
    const rawBody = req.body;

    if (!flutterwaveGateway.verifyWebhookSignature(rawBody, signature)) {
      logger.warn('Invalid Flutterwave webhook signature');
      return res.status(401).send('Unauthorized');
    }

    const payload = JSON.parse(rawBody.toString('utf8'));

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
        return res.status(400).send('Missing userId in meta');
      }

      const result = await processDepositWebhook({
        reference,
        amountMinorUnits,
        currency: data.currency,
        gateway: 'FLUTTERWAVE',
        userId
      });

      await handleDepositResult(res, result, userId);
      return;
    }

    if (payload.event?.startsWith('transfer.')) {
      await withdrawalService.handlePayoutCallback({
        gateway: 'FLUTTERWAVE',
        eventType: payload.event,
        data: payload.data
      });
      return res.status(200).send('OK');
    }

    res.status(200).send('OK');
  } catch (error) {
    logger.error({ error }, 'Flutterwave webhook error');
    res.status(500).send('Internal Server Error');
  }
});