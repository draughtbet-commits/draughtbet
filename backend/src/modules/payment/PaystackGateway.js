import crypto from 'crypto';
import logger from '../../utils/logger.js';
import { PaymentGateway, PaymentGatewayError } from './PaymentGateway.js';

export class PaystackGateway extends PaymentGateway {
  constructor() {
    super();
    this.secretKey = process.env.PAYSTACK_SECRET_KEY || '';
    if (!this.secretKey) {
      logger.warn('PAYSTACK_SECRET_KEY is missing from environment variables.');
    }
  }

  /**
   * Helper to fetch with timeout and retries
   */
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
        logger.warn({ attempt, error: error.message }, 'Paystack gateway request failed, retrying...');
        await new Promise((resolve) => setTimeout(resolve, backoff));
        attempt++;
        backoff *= 2; // exponential backoff
      }
    }
  }

  async initiatePayment(amountMinorUnits, userId, email) {
    try {
      // Amount in Paystack is expected in kobo (which matches our NGN minor units)
      const payload = {
        amount: amountMinorUnits.toString(),
        email: email,
        metadata: {
          userId: userId
        }
      };

      const data = await this.fetchWithRetry('https://api.paystack.co/transaction/initialize', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!data.status) {
        throw new Error(data.message || 'Paystack initialization failed');
      }

      return {
        authorizationUrl: data.data.authorization_url,
        reference: data.data.reference
      };
    } catch (error) {
      logger.error({ error, userId, amountMinorUnits: amountMinorUnits.toString() }, 'Failed to initiate Paystack payment');
      throw new PaymentGatewayError('Payment provider unavailable, try again', error);
    }
  }

  verifyWebhookSignature(rawBody, signatureHeader) {
    if (!this.secretKey) {
      logger.error('Cannot verify Paystack webhook without PAYSTACK_SECRET_KEY');
      return false;
    }
    const hash = crypto.createHmac('sha512', this.secretKey).update(rawBody).digest('hex');
    return hash === signatureHeader;
  }
}
