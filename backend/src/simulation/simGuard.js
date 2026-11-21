import crypto from 'node:crypto';

export const SIM_EMAIL_DOMAIN = '@draughtbet.sim';
export const SIM_USERNAME_PREFIX = 'sim_';

/**
 * Generates a compact, URL/email/username-safe simulation run identifier.
 */
export function createSimulationRunId() {
  return `r${Date.now().toString(36).slice(-4)}${crypto.randomBytes(2).toString('hex')}`;
}

export const simEmail = (index, runId = null) => {
  const padded = String(index).padStart(2, '0');
  if (!runId) return `sim.user${padded}${SIM_EMAIL_DOMAIN}`;
  return `sim+${String(runId).toLowerCase()}.u${padded}${SIM_EMAIL_DOMAIN}`;
};

export const simUsername = (index, runId = null) => {
  const padded = String(index).padStart(2, '0');
  if (!runId) return `sim_user_${padded}`;
  return `${SIM_USERNAME_PREFIX}${String(runId).toLowerCase()}_${padded}`;
};

export const simLabel = (index) => `User ${String(index).padStart(2, '0')}`;

export const isSimEmail = (email) =>
  typeof email === 'string' && email.toLowerCase().endsWith(SIM_EMAIL_DOMAIN);

export const isSimRunEmail = (email, runId) => {
  if (typeof email !== 'string' || !runId) return false;
  const lower = email.toLowerCase();
  return lower.startsWith(`sim+${String(runId).toLowerCase()}.`) && lower.endsWith(SIM_EMAIL_DOMAIN);
};

/**
 * Generates an ephemeral, policy-compliant password for synthetic simulation accounts.
 */
export const createEphemeralSimPassword = () =>
  `Sim!${crypto.randomBytes(9).toString('base64url')}9aA`;

/**
 * Enforces strict isolation & safety guards before any simulation runner or fixture reset executes.
 * Fails closed unless NODE_ENV === 'development' && SIMULATION_ENABLED === 'true', blocks live
 * payment keys, blocks Render production URLs, and only permits Neon when explicitly enabled
 * via SIMULATION_ALLOW_NEON=true alongside SIMULATION_MOCK_PAYMENTS=true.
 */
export function assertSafeSimulationEnvironment() {
  if (process.env.NODE_ENV !== 'development') {
    throw new Error(
      `Simulation refused: NODE_ENV must be "development" (got "${process.env.NODE_ENV ?? ''}").`
    );
  }
  if (process.env.SIMULATION_ENABLED !== 'true') {
    throw new Error(
      'Simulation refused: set SIMULATION_ENABLED=true in a development environment.'
    );
  }

  const dbUrl = String(process.env.DATABASE_URL || '');
  const lowerDbUrl = dbUrl.toLowerCase();
  if (!dbUrl || lowerDbUrl.includes('render.com')) {
    throw new Error(
      'Simulation refused: DATABASE_URL is missing or points to a blocked production host.'
    );
  }

  const pointsToNeon = lowerDbUrl.includes('neon.tech') || lowerDbUrl.includes('/neondb');
  if (pointsToNeon) {
    if (process.env.SIMULATION_ALLOW_NEON !== 'true') {
      throw new Error(
        'Simulation refused: DATABASE_URL points to Neon without SIMULATION_ALLOW_NEON=true.'
      );
    }
    if (process.env.SIMULATION_MOCK_PAYMENTS !== 'true') {
      throw new Error(
        'Simulation refused: SIMULATION_MOCK_PAYMENTS=true is required for Neon simulations.'
      );
    }
  }

  const paystackKey = String(process.env.PAYSTACK_SECRET_KEY || '');
  const flwKey = String(process.env.FLUTTERWAVE_SECRET_KEY || '');
  if (paystackKey.startsWith('sk_live_')) {
    throw new Error('Simulation refused: live PAYSTACK_SECRET_KEY detected.');
  }
  if (flwKey.startsWith('FLWSECK-') && !flwKey.startsWith('FLWSECK_TEST')) {
    throw new Error('Simulation refused: live FLUTTERWAVE_SECRET_KEY detected.');
  }
}

export function createPaystackMockSignature(rawBodyString) {
  const secret = typeof process.env.PAYSTACK_SECRET_KEY === 'string'
    ? process.env.PAYSTACK_SECRET_KEY.trim()
    : '';
  if (!secret) {
    throw new Error('Simulation refused: PAYSTACK_SECRET_KEY is required to sign mock webhooks.');
  }
  return crypto.createHmac('sha512', secret).update(rawBodyString).digest('hex');
}
