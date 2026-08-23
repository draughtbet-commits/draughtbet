export class PaymentGatewayError extends Error {
  constructor(message, originalError = null) {
    super(message);
    this.name = 'PaymentGatewayError';
    this.originalError = originalError;
  }
}

/**
 * Interface/Base class for Payment Gateways.
 */
export class PaymentGateway {
  /**
   * Initiates a payment.
   * @param {BigInt} amountMinorUnits - The amount in minor units (e.g. kobo)
   * @param {string} userId - The ID of the user depositing
   * @param {string} email - The email of the user depositing
   * @returns {Promise<{ authorizationUrl: string, reference: string }>}
   */
  async initiatePayment(amountMinorUnits, userId, email) {
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
   * Processes a refund through the gateway.
   * @param {string} reference - The original transaction reference
   * @param {BigInt} amountMinorUnits - The refund amount in minor units
   * @returns {Promise<{ success: boolean, refundReference: string }>}
   */
  async processRefund(reference, amountMinorUnits) {
    throw new Error('Not implemented');
  }
}
