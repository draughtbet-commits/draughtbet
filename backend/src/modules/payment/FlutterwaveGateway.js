import logger from '../../utils/logger.js';
import { PaymentGateway, PaymentGatewayError } from './PaymentGateway.js';

export class FlutterwaveGateway extends PaymentGateway {
  constructor() {
    super();
    this.secretKey = process.env.FLUTTERWAVE_SECRET_KEY || '';
    this.secretHash = process.env.FLUTTERWAVE_SECRET_HASH || '';
    if (!this.secretKey || !this.secretHash) {
      logger.warn('FLUTTERWAVE_SECRET_KEY or FLUTTERWAVE_SECRET_HASH missing from environment variables.');
    }
  }

  async fetchWithRetry(url, options, retries = 1, backoff = 1000) {
    let attempt = 0;
    while (attempt <= retries) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      try {
        const response = await fetch(url, {
          ...options,
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        
        if (!response.ok) {
          const body = await response.text();
          throw new Error(`HTTP error! status: ${response.status} body: ${body}`);
        }
        
        return await response.json();
      } catch (error) {
        clearTimeout(timeoutId);
        if (attempt === retries) {
          throw error;
        }
        logger.warn({ attempt, error: error.message }, 'Flutterwave gateway request failed, retrying...');
        await new Promise((resolve) => setTimeout(resolve, backoff));
        attempt++;
        backoff *= 2;
      }
    }
  }

  async initiatePayment(amountMinorUnits, userId, email, reference) {
    try {
      // Flutterwave expects amounts in major units (NGN) not kobo.
      // The intent is stored in integer minor units, so convert exactly with
      // integer math (no floating point): totalMinorUnits / 100.
      const minor = BigInt(amountMinorUnits);
      const major = minor / 100n;
      const frac = minor % 100n;
      const amountMajorUnits = `${major}.${frac.toString().padStart(2, '0')}`;

      // Use the server-created intent reference as tx_ref so the webhook can be
      // verified against the stored intent rather than an arbitrary ref.
      const txRef = reference || `flw-${Date.now()}-${userId}`;

      const payload = {
        tx_ref: txRef,
        amount: amountMajorUnits,
        currency: 'NGN',
        redirect_url: 'https://placeholder.uplix.com/payment/callback',
        customer: {
          email: email,
        },
        meta: {
          userId: userId
        }
      };

      const data = await this.fetchWithRetry('https://api.flutterwave.com/v3/payments', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (data.status !== 'success') {
        throw new Error(data.message || 'Flutterwave initialization failed');
      }

      return {
        authorizationUrl: data.data.link,
        reference: payload.tx_ref // In Flutterwave, tx_ref is the reference
      };
    } catch (error) {
      logger.error({ error, userId, amountMinorUnits: amountMinorUnits.toString() }, 'Failed to initiate Flutterwave payment');
      throw new PaymentGatewayError('Payment provider unavailable, try again', error);
    }
  }

  verifyWebhookSignature(rawBody, signatureHeader) {
    if (!this.secretHash) {
      logger.error('Cannot verify Flutterwave webhook without FLUTTERWAVE_SECRET_HASH');
      return false;
    }
    // Flutterwave requires checking if the 'verif-hash' matches the secret hash from dashboard
    return signatureHeader === this.secretHash;
  }
}
