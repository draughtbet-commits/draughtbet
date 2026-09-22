import crypto from 'crypto';

export class KycProviderError extends Error {
  constructor(message = 'KYC provider error') {
    super(message);
    this.name = 'KycProviderError';
  }
}

/**
 * Deterministic in-memory KYC provider. No real verification happens: the
 * adapter interface is the contract a real provider (Dojah, Flutterwave-KYC…)
 * must implement, and the SIMULATED_KYC_RESULT env var drives the outcome so
 * tests and the verify harness can exercise both the PASSED and FAILED paths.
 *
 * Real providers will use HTTP round-trips plus asynchronous webhook results;
 * keep `start`/`getResult` as the two seams so the service never needs to know
 * the provider's transport.
 */
export class SimulatedKycProvider {
  constructor({ result = process.env.SIMULATED_KYC_RESULT || 'pass' } = {}) {
    this.result = result === 'fail' ? 'FAILED' : 'PASSED';
  }

  async start(userId, { type = 'ID_DOCUMENT' } = {}) {
    return {
      providerReference: `sim-${crypto.randomUUID()}`,
      provider: 'simulated'
    };
  }

  async getResult(providerReference) {
    return {
      providerReference,
      status: this.result,
      checks: ['ID_DOCUMENT']
    };
  }
}

const PROVIDERS = {
  simulated: () => new SimulatedKycProvider()
};

export const createKycProvider = (name = 'simulated') => {
  const factory = PROVIDERS[name];
  if (!factory) {
    throw new KycProviderError(`Unknown KYC provider: ${name}`);
  }
  return factory();
};