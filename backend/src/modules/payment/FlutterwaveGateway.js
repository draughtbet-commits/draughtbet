import logger from '../../utils/logger.js';
import { PaymentGateway, PaymentGatewayError, toMajorUnits } from './PaymentGateway.js';

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
      const amountMajorUnits = toMajorUnits(amountMinorUnits);

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

  /**
   * Resolves a bank account to its on-file account name via Flutterwave's
   * account-resolution endpoint.
   */
  async resolveBankAccount({ bankCode, accountNumber }) {
    try {
      const data = await this.fetchWithRetry('https://api.flutterwave.com/v3/accounts/resolve', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ account_number: accountNumber, account_bank: bankCode })
      });
      if (data.status !== 'success' || !data.data?.account_name) {
        throw new Error(data.message || 'Flutterwave could not resolve this account number');
      }
      return { accountName: data.data.account_name, verified: true };
    } catch (error) {
      logger.warn({ error: error.message, bankCode, accountNumber }, 'Flutterwave account resolution failed');
      throw new PaymentGatewayError('Unable to verify this bank account', error);
    }
  }

  /**
   * Creates a reusable beneficiary so payouts can reference it by id.
   */
  async createRecipient({ bankCode, accountNumber, accountName }) {
    try {
      const data = await this.fetchWithRetry('https://api.flutterwave.com/v3/beneficiaries', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          account_number: accountNumber,
          account_bank: bankCode,
          beneficiary_name: accountName
        })
      });
      if (data.status !== 'success' || !data.data?.id) {
        throw new Error(data.message || 'Flutterwave beneficiary creation failed');
      }
      return { recipientRef: String(data.data.id) };
    } catch (error) {
      logger.warn({ error: error.message, bankCode, accountNumber }, 'Flutterwave beneficiary creation failed');
      throw new PaymentGatewayError('Unable to create payout recipient', error);
    }
  }

  /**
   * Initiates a payout via Flutterwave Transfers. Amount must be major units;
   * converted with exact integer math.
   */
  async initiatePayout({ amountMinorUnits, currency, recipientRef, reference }) {
    try {
      const data = await this.fetchWithRetry('https://api.flutterwave.com/v3/transfers', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          beneficiary_id: recipientRef,
          amount: toMajorUnits(amountMinorUnits),
          currency: currency || 'NGN',
          reference,
          narration: 'Draught Bet withdrawal payout'
        })
      });
      if (data.status !== 'success' || !data.data?.id) {
        throw new Error(data.message || 'Flutterwave transfer initiation failed');
      }
      return {
        providerRef: String(data.data.id),
        status: data.data.status
      };
    } catch (error) {
      logger.error({ error, amountMinorUnits: amountMinorUnits.toString() }, 'Failed to initiate Flutterwave payout');
      throw new PaymentGatewayError('Payment provider unavailable, try again', error);
    }
  }
}
