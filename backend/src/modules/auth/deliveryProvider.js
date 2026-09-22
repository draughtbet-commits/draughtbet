import logger from '../../utils/logger.js';
import { VerificationChallengeError, mailboxDeliver, mailboxReadCode, OTP_TTL_SECONDS } from './verificationChallengeService.js';

// OTP delivery providers. The engine only calls `deliver({ userId, purpose,
// code, challengeId })`; which provider serves it is chosen by the factory
// from OTP_DELIVERY. Codes are never logged by any provider.

export const DISCARD_MODE = 'discard';
export const MAILBOX_MODE = 'mailbox';
export const EMAIL_MODE = 'email';

export class OTPDeliveryError extends VerificationChallengeError {
  constructor(message = 'OTP delivery unavailable', code = 'OTP_DELIVERY_UNAVAILABLE') {
    super(message, { status: 503, code });
    this.name = 'OTPDeliveryError';
  }
}

export class EmailDeliveryProvider {
  async deliver() {
    throw new Error('Not implemented');
  }
}

/**
 * Discards the code (no provider configured). Non-production default so tests,
 * CI and stalled dev stacks never block the flow with no real transport.
 */
export class DiscardDeliveryProvider {
  async deliver({ userId, purpose }) {
    logger.info({ userId, purpose }, 'OTP issued (no delivery provider configured)');
    return { delivered: false, channel: null };
  }
}

/**
 * Dev/test-only mailbox: stashes the code in Redis so an e2e driver can read
 * it back. Never part of a production delivery path.
 */
export class MailboxDeliveryProvider {
  async deliver({ userId, purpose, code, challengeId, destination }) {
    return { delivered: await mailboxDeliver({ userId, purpose, code, challengeId, destination }), channel: 'mailbox' };
  }

  async readCode(challengeId) {
    return mailboxReadCode(challengeId);
  }
}

/**
 * Production email delivery over a transactional email HTTP API (Resend
 * "POST /emails" shape; swap the body/headers here for Brevo, Mailgun, …).
 * Fail-closed: a channel that has no reachable provider throws so the caller
 * can surface 503 instead of silently dropping the code. The code is never
 * written to logs.
 */
export class HttpEmailProvider extends EmailDeliveryProvider {
  constructor({ apiUrl = process.env.EMAIL_API_URL, apiKey = process.env.EMAIL_API_KEY, from = process.env.EMAIL_FROM, timeoutMs = 5000 } = {}) {
    super();
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
    this.from = from;
    this.timeoutMs = timeoutMs;
    if (!this.apiUrl || !this.apiKey || !this.from) {
      logger.warn('EMAIL_API_URL / EMAIL_API_KEY / EMAIL_FROM must all be set for email OTP delivery');
    }
  }

  get configured() {
    return Boolean(this.apiUrl && this.apiKey && this.from);
  }

  async deliver({ purpose, code, destination, userId, challengeId }) {
    if (!this.configured) {
      throw new OTPDeliveryError('Email OTP delivery is not configured');
    }
    if (!destination) {
      throw new OTPDeliveryError('Email OTP delivery is missing a destination', 'OTP_DELIVERY_FAILED');
    }
    const body = {
      from: this.from,
      to: [destination],
      subject: subjectFor(purpose),
      text: `Your verification code is ${code}. It expires in ${OTP_TTL_SECONDS / 60} minutes.`
    };
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (!response.ok) {
        const detail = await response.text();
        logger.error({ status: response.status, detail, challengeId, purpose, userId }, 'Email OTP delivery failed (API error)');
        throw new OTPDeliveryError('Email OTP delivery failed', 'OTP_DELIVERY_FAILED');
      }
      logger.info({ challengeId, purpose, userId }, 'OTP delivered by email');
      return { delivered: true, channel: 'email' };
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof OTPDeliveryError) throw err;
      logger.warn({ challengeId, purpose, userId, error: err.message }, 'Email OTP delivery failed');
      throw new OTPDeliveryError('Email OTP delivery failed', 'OTP_DELIVERY_FAILED');
    }
  }
}

const subjectFor = (purpose) => {
  if (purpose === 'PASSWORD_RESET') return 'Your Draught Bet password reset code';
  if (purpose === 'PHONE_VERIFY') return 'Your Draught Bet phone verification code';
  return 'Your Draught Bet verification code';
};

/**
 * Anonymous helper so production always fails loudly when a channel has no
 * provider (see fixplan D-question: never silently drop codes).
 */
export class FailClosedProvider {
  async deliver() {
    throw new OTPDeliveryError('OTP delivery is not configured');
  }
}

const MODES = new Map([
  [DISCARD_MODE, () => new DiscardDeliveryProvider()],
  [MAILBOX_MODE, () => new MailboxDeliveryProvider()],
  [EMAIL_MODE, () => new HttpEmailProvider()]
]);

let cached = null;

/**
 * Creates (once) and returns the delivery provider selected by OTP_DELIVERY.
 *   email      -> HttpEmailProvider (production email; fail-closed when unconfigured)
 *   mailbox    -> MailboxDeliveryProvider (dev/test e2e)
 *   discard    -> DiscardDeliveryProvider (tests/CI)
 *   <unset>    -> discard in non-production; fail-closed in production
 */
export const getDeliveryProvider = ({ env = process.env } = {}) => {
  if (cached) return cached;
  // DEV_OTP_MAILBOX=1 is the legacy dev/e2e shortcut for the mailbox mode.
  const mode = env.OTP_DELIVERY || (env.DEV_OTP_MAILBOX === '1' ? MAILBOX_MODE : env.NODE_ENV === 'production' ? null : DISCARD_MODE);
  if (!mode) {
    cached = new FailClosedProvider();
    return cached;
  }
  const factory = MODES.get(mode);
  if (!factory) {
    logger.warn({ mode }, 'Unknown OTP_DELIVERY mode, falling back to discard');
    cached = new DiscardDeliveryProvider();
    return cached;
  }
  cached = factory();
  return cached;
};

export const resetDeliveryProviderCache = () => {
  cached = null;
};