import crypto from 'crypto';

export class KycProviderError extends Error {
  constructor(message = 'KYC provider error') {
    super(message);
    this.name = 'KycProviderError';
  }
}

/**
 * Simulated auto-verification is strictly forbidden in production and disabled
 * by default in development unless explicitly opted into (ALLOW_SIMULATED_KYC=true
 * or local dev SIMULATION_ENABLED=true).
 */
export const isSimulatedKycAllowed = () => {
  if (process.env.NODE_ENV === 'production') {
    return false;
  }
  if (process.env.NODE_ENV === 'test') {
    return true;
  }
  return (
    process.env.NODE_ENV === 'development' &&
    (process.env.ALLOW_SIMULATED_KYC === 'true' || process.env.SIMULATION_ENABLED === 'true')
  );
};

/**
 * Default safe KYC provider when no external automated KYC vendor (e.g. Dojah)
 * is integrated. Always places submissions into UNDER_REVIEW so an authorized
 * compliance reviewer must inspect and approve them; NEVER auto-verifies users.
 */
export class ManualReviewKycProvider {
  async start(_userId, { type = 'ID_DOCUMENT' } = {}) {
    return {
      providerReference: `manual-${crypto.randomUUID()}`,
      provider: 'manual',
      type
    };
  }

  async getResult(providerReference) {
    return {
      providerReference,
      provider: 'manual',
      status: 'UNDER_REVIEW',
      verdict: 'MANUAL_REVIEW_REQUIRED',
      checks: ['ID_DOCUMENT']
    };
  }
}

/**
 * Deterministic in-memory KYC provider strictly for automated tests and
 * explicitly opted-in local development simulations. Refuses to execute in
 * production so players can never self-verify via POST /verification/start.
 */
export class SimulatedKycProvider {
  constructor({ result = process.env.SIMULATED_KYC_RESULT || 'pass' } = {}) {
    if (!isSimulatedKycAllowed()) {
      throw new KycProviderError('Simulated KYC provider is disabled in this environment');
    }
    this.result = result === 'fail' ? 'FAILED' : 'PASSED';
  }

  async start(_userId, { type = 'ID_DOCUMENT' } = {}) {
    if (!isSimulatedKycAllowed()) {
      throw new KycProviderError('Simulated KYC provider is disabled in this environment');
    }
    return {
      providerReference: `sim-${crypto.randomUUID()}`,
      provider: 'simulated',
      type
    };
  }

  async getResult(providerReference) {
    if (!isSimulatedKycAllowed()) {
      throw new KycProviderError('Simulated KYC provider is disabled in this environment');
    }
    return {
      providerReference,
      provider: 'simulated',
      status: this.result,
      checks: ['ID_DOCUMENT']
    };
  }
}

const PROVIDERS = {
  manual: () => new ManualReviewKycProvider(),
  simulated: () => new SimulatedKycProvider()
};

export const resolveDefaultKycProviderName = () => {
  const configured = typeof process.env.KYC_PROVIDER === 'string'
    ? process.env.KYC_PROVIDER.trim().toLowerCase()
    : '';
  if (configured) {
    return configured;
  }
  return 'manual';
};

export const createKycProvider = (name = resolveDefaultKycProviderName()) => {
  const normalized = typeof name === 'string' ? name.trim().toLowerCase() : 'manual';
  if (normalized === 'simulated' && !isSimulatedKycAllowed()) {
    throw new KycProviderError(
      'Simulated KYC provider is forbidden in production or without explicit development opt-in'
    );
  }
  const factory = PROVIDERS[normalized];
  if (!factory) {
    throw new KycProviderError(`Unsupported or unconfigured KYC provider: ${normalized}`);
  }
  return factory();
};
