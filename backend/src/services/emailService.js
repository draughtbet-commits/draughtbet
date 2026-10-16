import logger from '../utils/logger.js';

/**
 * Generic transactional email transport (Resend "POST /emails" shape). This is
 * the shared sender behind every non-OTP email (welcome, receipts, security
 * alerts). OTP codes keep their own fail-closed provider
 * (modules/auth/deliveryProvider.js) because a dropped code must surface a 503.
 *
 * Transactional mail is best-effort on purpose: it is a side channel, never the
 * source of truth, so a provider outage must not fail the action that triggered
 * it. [sendEmail] therefore never throws; callers ignore the result.
 *
 * Config (all required, else email is disabled):
 *   EMAIL_API_URL  e.g. https://api.resend.com/emails
 *   EMAIL_API_KEY  provider API key
 *   EMAIL_FROM     e.g. "Draught Bet <no-reply@draughtbet.com>" (domain must be
 *                  verified with the provider / SPF+DKIM)
 */

export class EmailDeliveryError extends Error {
  constructor(message, code = 'EMAIL_DELIVERY_FAILED') {
    super(message);
    this.name = 'EmailDeliveryError';
    this.code = code;
  }
}

export const isEmailConfigured = ({ env = process.env } = {}) =>
  Boolean(env.EMAIL_API_URL && env.EMAIL_API_KEY && env.EMAIL_FROM);

/**
 * Sends one email and throws on any failure. Used where the caller must know the
 * outcome; [sendEmail] is the best-effort wrapper used by transactional events.
 */
export const deliverEmail = async (
  { to, subject, text, html, from, timeoutMs = 5000 } = {},
  { env = process.env, fetchImpl = fetch } = {}
) => {
  const apiUrl = env.EMAIL_API_URL;
  const apiKey = env.EMAIL_API_KEY;
  const sender = from || env.EMAIL_FROM;
  if (!apiUrl || !apiKey || !sender) {
    throw new EmailDeliveryError('Email delivery is not configured', 'EMAIL_NOT_CONFIGURED');
  }
  if (!to || !subject) {
    throw new EmailDeliveryError('Email requires a recipient and subject', 'EMAIL_INVALID');
  }

  const body = { from: sender, to: [to], subject, ...(text ? { text } : {}), ...(html ? { html } : {}) };
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(apiUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      logger.error({ status: response.status, detail }, 'Transactional email delivery failed (API error)');
      throw new EmailDeliveryError('Email provider rejected the message');
    }
    return { delivered: true, channel: 'email' };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof EmailDeliveryError) throw err;
    logger.warn({ error: err.message }, 'Transactional email delivery failed');
    throw new EmailDeliveryError('Email delivery failed');
  }
};

/**
 * Best-effort send for transactional events. Never throws: a missing config or a
 * provider failure is logged and swallowed. Returns a small summary so callers
 * (and tests) can assert without catching.
 */
export const sendEmail = async (payload, deps) => {
  if (!isEmailConfigured(deps)) {
    logger.debug({ to: payload?.to }, 'Transactional email skipped (not configured)');
    return { delivered: false, skipped: true };
  }
  if (!payload?.to) {
    return { delivered: false, skipped: true };
  }
  try {
    await deliverEmail(payload, deps);
    logger.info({ to: payload.to, subject: payload.subject }, 'Transactional email sent');
    return { delivered: true, skipped: false };
  } catch (err) {
    logger.warn({ to: payload.to, subject: payload.subject, error: err.message }, 'Transactional email failed (non-blocking)');
    return { delivered: false, skipped: false, error: err.message };
  }
};

export default { isEmailConfigured, deliverEmail, sendEmail };
