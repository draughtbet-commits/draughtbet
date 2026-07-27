import express from 'express';
import { processDepositWebhook } from '../wallet/service.js';
import { PaystackGateway } from './PaystackGateway.js';
import { FlutterwaveGateway } from './FlutterwaveGateway.js';
import logger from '../../utils/logger.js';

export const webhookRouter = express.Router();

const paystackGateway = new PaystackGateway();
const flutterwaveGateway = new FlutterwaveGateway();

// Webhooks must use raw body parsing to verify signatures exactly
webhookRouter.use(express.raw({ type: 'application/json' }));

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
      // Paystack sends amount in kobo which is our minor units
      const amountMinorUnits = data.amount;
      const userId = data.metadata?.userId;

      if (!userId) {
        logger.error({ reference }, 'Paystack webhook payload missing userId in metadata');
        return res.status(400).send('Missing userId in metadata');
      }

      await processDepositWebhook(reference, amountMinorUnits, 'PAYSTACK', userId);
    }

    res.status(200).send('OK');
  } catch (error) {
    logger.error({ error }, 'Paystack webhook error');
    // Always return 200 to prevent retries if it's an internal error or idempotency already handled it
    // Actually, if we return 500, they retry. We probably want them to retry if our DB is down.
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

    // Flutterwave event types vary, but 'charge.completed' with status 'successful' is typical
    // According to docs, 'event' could be 'charge.completed'
    if (payload.event === 'charge.completed' && payload.data.status === 'successful') {
      const data = payload.data;
      const reference = data.tx_ref;
      // Flutterwave sends amount in major units, we must convert to minor units (kobo)
      // Note: check Flutterwave docs for exact webhook amount format. Typically it's major units.
      const amountMinorUnits = Math.round(Number(data.amount) * 100);
      const userId = data.meta?.userId;

      if (!userId) {
        logger.error({ reference }, 'Flutterwave webhook payload missing userId in meta');
        return res.status(400).send('Missing userId in meta');
      }

      await processDepositWebhook(reference, amountMinorUnits, 'FLUTTERWAVE', userId);
    }

    res.status(200).send('OK');
  } catch (error) {
    logger.error({ error }, 'Flutterwave webhook error');
    res.status(500).send('Internal Server Error');
  }
});
