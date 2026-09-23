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

  async initiatePayment(amountMinorUnits, userId, email, reference) {
    try {
      // Amount in Paystack is expected in kobo (which matches our NGN minor units)
      const payload = {
        amount: amountMinorUnits.toString(),
        email: email,
        metadata: {
          userId: userId
        }
      };
      // Pass OUR server-created intent reference through so the webhook can be
      // verified against the stored intent instead of an arbitrary provider ref.
      if (reference) {
        payload.reference = reference;
      }

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

  /**
   * Resolves a bank account to its on-file account name via Paystack's bank
   * resolution endpoint. Real NGN accounts resolve; provider test numbers that
   * the bank does not route throw PaymentGatewayError (callers treat that as
   * "not verifiable", never as a verified account).
   */
  async resolveBankAccount({ bankCode, accountNumber }) {
    try {
      const data = await this.fetchWithRetry(
        `https://api.paystack.co/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
        {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${this.secretKey}` }
        }
      );
      if (!data.status || !data.data?.account_name) {
        throw new Error('Paystack could not resolve this account number');
      }
      return { accountName: data.data.account_name, verified: true };
    } catch (error) {
      logger.warn({ error: error.message, bankCode, accountNumber }, 'Paystack account resolution failed');
      throw new PaymentGatewayError('Unable to verify this bank account', error);
    }
  }

  /**
   * Creates a reusable transfer recipient (nuban) so payouts can reference it.
   */
  async createRecipient({ bankCode, accountNumber, accountName }) {
    try {
      const data = await this.fetchWithRetry('https://api.paystack.co/transferrecipient', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          type: 'nuban',
          name: accountName,
          account_number: accountNumber,
          bank_code: bankCode,
          currency: 'NGN'
        })
      });
      if (!data.status || !data.data?.recipient_code) {
        throw new Error(data.message || 'Paystack recipient creation failed');
      }
      return { recipientRef: data.data.recipient_code };
    } catch (error) {
      logger.warn({ error: error.message, bankCode, accountNumber }, 'Paystack recipient creation failed');
      throw new PaymentGatewayError('Unable to create payout recipient', error);
    }
  }

  /**
   * Initiates a payout via Paystack Transfers. Amount is in kobo (already our
   * NGN minor units — passed through untouched).
   */
  async initiatePayout({ amountMinorUnits, currency, recipientRef, reference }) {
    try {
      const data = await this.fetchWithRetry('https://api.paystack.co/transfer', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          source: 'balance',
          amount: BigInt(amountMinorUnits).toString(),
          recipient: recipientRef,
          currency: currency || 'NGN',
          reference
        })
      });
      if (!data.status || !data.data?.transfer_code) {
        throw new Error(data.message || 'Paystack transfer initiation failed');
      }
      return {
        providerRef: data.data.transfer_code,
        status: data.data.status
      };
    } catch (error) {
      logger.error({ error, amountMinorUnits: amountMinorUnits.toString() }, 'Failed to initiate Paystack payout');
      throw new PaymentGatewayError('Payment provider unavailable, try again', error);
    }
  }

  /**
   * Queries Paystack Transfers for the payout's current status. We initiated
   * every payout with OUR `reference`, which /transfer/verify accepts as the
   * lookup key. Only an explicit success/failure verdict drives the follow-up;
   * any in-flight status is 'processing' and gets re-checked on the next pass.
   */
  async verifyPayoutStatus({ reference, providerRef }) {
    try {
      const key = encodeURIComponent(reference || providerRef || '');
      const data = await this.fetchWithRetry(
        `https://api.paystack.co/transfer/verify/${key}`,
        {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${this.secretKey}` }
        }
      );
      const status = data?.data?.status ?? '';
      return { status: mapPaystackTransferStatus(status) };
    } catch (error) {
      logger.warn({ error: error.message, reference }, 'Paystack payout status verification failed');
      throw new PaymentGatewayError('Unable to verify payout status', error);
    }
  }
}

/**
 * Maps a Paystack transfer status to the follow-up verdict.
 *   success                      -> 'success'  (only terminal good)
 *   failed | reversed            -> 'failed'   (only terminal bad)
 *   pending | otp | processing | abandoned | paused ...
 *                                -> 'processing' (keep waiting)
 */
export function mapPaystackTransferStatus(status) {
  if (status === 'success') return 'success';
  if (status === 'failed' || status === 'reversed') return 'failed';
  return 'processing';
}
