import crypto from 'crypto';
import logger from '../../utils/logger.js';

export class KycProviderError extends Error {
  constructor(message = 'KYC provider error') {
    super(message);
    this.name = 'KycProviderError';
  }
}

/**
 * Deterministic in-memory KYC provider. No real verification happens: the
 * adapter interface is the contract a real provider must implement, and the
 * SIMULATED_KYC_RESULT env var drives the outcome so tests and the verify
 * harness can exercise both the PASSED and FAILED paths.
 *
 * It answers inline, so it is the one provider that legitimately reports a
 * result from `start()`. Real providers are asynchronous and declare
 * `mode: 'async'`, which leaves the case pending for a webhook instead.
 */
export class SimulatedKycProvider {
  constructor({ result = process.env.SIMULATED_KYC_RESULT || 'pass' } = {}) {
    this.result = result === 'fail' ? 'FAILED' : 'PASSED';
  }

  get mode() {
    return 'sync';
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

/** Labels Dojah uses for a verification that reached a negative conclusion. */
const DOJAH_FAILURE_STATUSES = new Set(['failed', 'abandoned']);

/**
 * Dojah adapter.
 *
 * Dojah hosts the capture experience: the player completes ID capture and a
 * liveness selfie on their widget, and Dojah decides the outcome out of band.
 * So `start` does not call Dojah at all — we mint the `reference_id` that
 * identifies the attempt and hand back the widget URL to open. Dojah echoes
 * that reference back on the webhook, which is what lets an asynchronous result
 * be matched to its case.
 *
 * Auth is two headers, with the secret sent raw rather than as a Bearer token.
 */
export class DojahKycProvider {
  constructor({
    appId = process.env.DOJAH_APP_ID,
    secretKey = process.env.DOJAH_SECRET_KEY,
    baseUrl = process.env.DOJAH_BASE_URL || 'https://sandbox.dojah.io',
    widgetId = process.env.DOJAH_WIDGET_ID,
    timeoutMs = 15000
  } = {}) {
    this.appId = appId;
    this.secretKey = secretKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.widgetId = widgetId;
    this.timeoutMs = timeoutMs;
  }

  /** The result arrives by webhook long after this call returns. */
  get mode() {
    return 'async';
  }

  /**
   * Mints the attempt reference and builds the URL the player completes.
   *
   * The reference is opaque and carries no PII: Dojah echoes it into client
   * callbacks, widget URLs and logs, so anything identifying in it leaks.
   */
  async start(userId) {
    if (!this.widgetId) {
      throw new KycProviderError('DOJAH_WIDGET_ID is not configured');
    }
    // Dojah requires at least 10 characters for a reference_id.
    const providerReference = `dbt-${crypto.randomUUID().replace(/-/g, '')}`;
    return {
      providerReference,
      provider: 'dojah',
      widgetUrl: this.widgetUrlFor(providerReference),
      widgetId: this.widgetId
    };
  }

  widgetUrlFor(providerReference) {
    const url = new URL('https://identity.dojah.io/');
    url.searchParams.set('widget_type', 'custom');
    url.searchParams.set('widget_id', this.widgetId);
    url.searchParams.set('reference_id', providerReference);
    return url.toString();
  }

  headers() {
    if (!this.appId || !this.secretKey) {
      throw new KycProviderError('Dojah credentials are not configured');
    }
    // Dojah expects the secret raw in Authorization, not as a Bearer token.
    return { AppId: this.appId, Authorization: this.secretKey };
  }

  /**
   * Polls a verification by reference. This is the fallback for a lost webhook,
   * not the primary path — the case is already resolved by the time anyone
   * needs to ask.
   */
  async getResult(providerReference) {
    const url = `${this.baseUrl}/api/v1/kyc/verification?reference_id=${encodeURIComponent(providerReference)}`;
    let res;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: this.headers(),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      throw new KycProviderError(`Dojah verification lookup failed: ${error.message}`);
    }

    if (res.status === 404) {
      // Nothing recorded yet is not a failure; the widget may still be open.
      return { providerReference, status: 'PENDING', checks: [] };
    }
    if (res.status === 429) {
      throw new KycProviderError('Dojah rate limited the verification lookup');
    }
    if (!res.ok) {
      throw new KycProviderError(`Dojah verification lookup returned ${res.status}`);
    }

    const payload = await res.json();
    return mapDojahVerification(payload);
  }

  /**
   * Verifies an `x-dojah-signature` delivery: HMAC-SHA256 of the raw body,
   * keyed with the secret. Compared in constant time, and only after a length
   * check, because timingSafeEqual throws on a length mismatch.
   *
   * Fails closed: an unconfigured secret rejects every delivery rather than
   * waving them through.
   */
  verifyWebhookSignature(rawBody, signature) {
    if (!this.secretKey) {
      logger.error('Rejecting Dojah webhook: DOJAH_SECRET_KEY is not configured');
      return false;
    }
    if (typeof signature !== 'string' || signature.length === 0) return false;

    const expected = crypto.createHmac('sha256', this.secretKey).update(rawBody).digest('hex');
    const got = Buffer.from(signature);
    const want = Buffer.from(expected);
    if (got.length !== want.length) return false;
    return crypto.timingSafeEqual(got, want);
  }
}

/**
 * Maps Dojah's `data` keys onto our VerificationCheckType vocabulary.
 *
 * Anything not listed is dropped rather than guessed: the column is a database
 * enum, so an unmapped provider key cannot be stored, and silently coercing
 * `aml` into a made-up check type would misreport what was actually verified.
 */
const DOJAH_CHECK_TYPE_MAP = Object.freeze({
  id: 'ID_DOCUMENT',
  // Government data is the ID's registry/validity check — the same evidence as
  // the document capture itself, so it collapses onto one check.
  government_data: 'ID_DOCUMENT',
  selfie: 'SELFIE',
  address: 'PROOF_OF_ADDRESS',
  bvn: 'BVN',
  nin: 'NIN'
});

/**
 * Normalises a Dojah verification payload into the adapter's result shape.
 *
 * Dojah reports an overall `status` boolean plus a verbose `verification_status`
 * label, and breaks the result down per check. Exposing the per-check statuses
 * is what lets a partially failed verification be recorded honestly instead of
 * flattened to a single pass or fail.
 */
export const mapDojahVerification = (payload) => {
  const label = String(payload?.verification_status ?? '').toLowerCase();
  const data = payload?.data ?? {};

  // Collapse to one entry per check type: several Dojah keys can map to the
  // same type, and a duplicate would otherwise produce duplicate check rows.
  const byType = new Map();
  for (const [key, value] of Object.entries(data)) {
    const type = DOJAH_CHECK_TYPE_MAP[key];
    if (!type || !value || typeof value !== 'object') continue;
    const passed = value.status === true;
    const seen = byType.get(type);
    byType.set(type, {
      type,
      passed: seen ? seen.passed && passed : passed,
      // Kept for admin review; sanitised before it is persisted.
      message: typeof value.message === 'string' ? value.message : null
    });
  }
  const checks = [...byType.values()];

  let status;
  if (label === 'completed') {
    status = payload?.status === true ? 'PASSED' : 'FAILED';
  } else if (DOJAH_FAILURE_STATUSES.has(label)) {
    status = 'FAILED';
  } else {
    // Everything else is in flight or unrecognised. Defaulting to pending means
    // a provider state we have not seen can never reject a player on a guess —
    // an unsettled verification leaves them gated, which is the safe direction.
    status = 'PENDING';
  }

  return {
    providerReference: payload?.reference_id ?? null,
    status,
    checks,
    verificationType: payload?.verification_type ?? null,
    idType: payload?.id_type ?? null,
    message: typeof payload?.message === 'string' ? payload.message : null
  };
};

const PROVIDERS = {
  simulated: () => new SimulatedKycProvider(),
  dojah: () => new DojahKycProvider()
};

export const createKycProvider = (name = process.env.KYC_PROVIDER || 'simulated') => {
  // The simulated provider approves anyone who calls it. If that ever becomes
  // the production setting, every player would be waved through verification,
  // so it is refused outright rather than left to a config mistake.
  if (name === 'simulated' && process.env.NODE_ENV === 'production') {
    throw new KycProviderError(
      'KYC_PROVIDER is "simulated" in production, which would approve every applicant'
    );
  }
  const factory = PROVIDERS[name];
  if (!factory) {
    throw new KycProviderError(`Unknown KYC provider: ${name}`);
  }
  return factory();
};

export const SUPPORTED_KYC_PROVIDERS = Object.freeze(Object.keys(PROVIDERS));