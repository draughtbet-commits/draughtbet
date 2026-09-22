export class PaymentGatewayError extends Error {
  constructor(message, originalError = null) {
    super(message);
    this.name = 'PaymentGatewayError';
    this.originalError = originalError;
  }
}

/**
 * Converts a canonical minor-unit BigInt (e.g. kobo) to the exact major-unit
 * decimal string providers like Flutterwave expect ("50000" -> "500.00").
 * Integer math only — never Number().
 */
export const toMajorUnits = (amountMinorUnits) => {
  const minor = BigInt(amountMinorUnits);
  const major = minor / 100n;
  const frac = minor % 100n;
  return `${major}.${frac.toString().padStart(2, '0')}`;
};

/**
 * Interface/Base class for Payment Gateways.
 */
export class PaymentGateway {
  /**
   * Initiates a payment.
   * @param {BigInt} amountMinorUnits - The amount in minor units (e.g. kobo)
   * @param {string} userId - The ID of the user depositing
   * @param {string} email - The email of the user depositing
   * @param {string} [reference] - Optional server-created intent reference; when
   *   provided the gateway must echo it (Paystack `reference` / Flutterwave
   *   `tx_ref`) so webhooks can be verified against the stored intent.
   * @returns {Promise<{ authorizationUrl: string, reference: string }>}
   */
  async initiatePayment(amountMinorUnits, userId, email, reference) {
    throw new Error('Not implemented');
  }

  /**
   * Verifies the webhook signature.
   * @param {Buffer} rawBody - The raw request body buffer
   * @param {string} signatureHeader - The signature from the request header
   * @returns {boolean}
   */
  verifyWebhookSignature(rawBody, signatureHeader) {
    throw new Error('Not implemented');
  }

  /**
   * Resolves a bank account at the provider, returning the account name on file.
   * Throws PaymentGatewayError if the accounts bank/number pair cannot be
   * resolved (invalid, or provider-test numbers that the bank does not route).
   * @param {{ bankCode: string, accountNumber: string }} input
   * @returns {Promise<{ accountName: string, verified: boolean }>}
   */
  async resolveBankAccount({ bankCode, accountNumber }) {
    throw new Error('Not implemented');
  }

  /**
   * Creates a reusable payout recipient/beneficiary at the provider.
   * @param {{ bankCode: string, accountNumber: string, accountName: string }} input
   * @returns {Promise<{ recipientRef: string }>} provider-side recipient id
   */
  async createRecipient({ bankCode, accountNumber, accountName }) {
    throw new Error('Not implemented');
  }

  /**
   * Initiates a payout (transfer) for a previously-created recipient.
   * @param {{ amountMinorUnits: BigInt, currency: string, recipientRef: string, reference: string }} input
   * @returns {Promise<{ providerRef: string, status: string }>}
   */
  async initiatePayout({ amountMinorUnits, currency, recipientRef, reference }) {
    throw new Error('Not implemented');
  }

  /**
   * Processes a refund through the gateway.
   * @param {string} reference - The original transaction reference
   * @param {BigInt} amountMinorUnits - The refund amount in minor units
   * @returns {Promise<{ success: boolean, refundReference: string }>}
   */
  async processRefund(reference, amountMinorUnits) {
    throw new Error('Not implemented');
  }

  /**
   * Queries the provider for the current status of an initiated payout, so the
   * follow-up sweep can resolve withdrawals stuck in PROCESSING when no webhook
   * ever arrived.
   * @param {{ reference: string, providerRef: string|null }} input - Our server
   *   reference and the provider's payout id (transfer_code / transfer id).
   * @returns {Promise<{ status: 'success'|'failed'|'processing' }>} the provider
   *   verdict. Throws PaymentGatewayError only on transport/provider errors
   *   (the sweep then leaves the withdrawal untouched and retries later).
   */
  async verifyPayoutStatus({ reference, providerRef }) {
    throw new Error('Not implemented');
  }
}
