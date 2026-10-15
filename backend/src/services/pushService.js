import admin from 'firebase-admin';
import prisma from '../utils/db.js';
import logger from '../utils/logger.js';
import { decryptToken } from '../modules/me/pushTokenService.js';

/**
 * FCM delivery for offline players. Push is a best-effort side channel: the
 * notification row is already durable in the DB, so a send failure is logged
 * and never allowed to fail the outbox event that triggered it.
 *
 * Auth comes from FIREBASE_SERVICE_ACCOUNT_KEY, which may be either the raw
 * service-account JSON or its base64 encoding (newlines in an env var are
 * awkward). When it is absent or malformed, push is disabled and callers fall
 * back to the socket-only path.
 */

let messaging = null;
let initialized = false;

const parseServiceAccount = (raw) => {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const json = text.startsWith('{')
    ? text
    : (() => {
        try {
          return Buffer.from(text, 'base64').toString('utf8');
        } catch {
          return '';
        }
      })();
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
};

const initMessaging = () => {
  if (initialized) return messaging;
  initialized = true;

  const creds = parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  if (!creds || !creds.project_id || !creds.client_email || !creds.private_key) {
    logger.warn('FCM disabled: FIREBASE_SERVICE_ACCOUNT_KEY is missing or malformed');
    return null;
  }

  try {
    // A named app keeps this isolated from any default app a test harness might
    // create, and makes repeated initialization idempotent.
    const app = admin.apps.some((a) => a?.name === 'draughtbet-push')
      ? admin.app('draughtbet-push')
      : admin.initializeApp({ credential: admin.credential.cert(creds) }, 'draughtbet-push');
    messaging = admin.messaging(app);
    logger.info({ projectId: creds.project_id }, 'FCM messaging initialized');
  } catch (error) {
    logger.error({ error }, 'FCM initialization failed; push disabled');
    messaging = null;
  }
  return messaging;
};

/** True when a service-account key is present and parsed into a usable client. */
export const isPushConfigured = () => Boolean(initMessaging());

/** Test seam: forget the cached client so a new env value takes effect. */
export const __resetPushForTests = () => {
  initialized = false;
  messaging = null;
};

// FCM error codes that mean the token is dead and should be revoked, so we stop
// sending to it. Anything else (transient/network/internal) keeps the token.
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument'
]);

const isDeadToken = (error) =>
  DEAD_TOKEN_CODES.has(error?.code) ||
  DEAD_TOKEN_CODES.has(error?.errorInfo?.code);

const stringifyData = (data) => {
  const out = {};
  for (const [key, value] of Object.entries(data ?? {})) {
    if (value === undefined || value === null) continue;
    out[key] = String(value);
  }
  return out;
};

/**
 * Sends one notification to every active device of a user. Returns a summary
 * and never throws: push must not break the delivery pipeline. Tokens FCM
 * reports as dead are deactivated so future sends skip them.
 */
export const sendToUser = async (userId, { title, body, data } = {}) => {
  const client = initMessaging();
  if (!client) return { configured: false, sent: 0, failed: 0, skipped: 0 };

  const rows = await prisma.devicePushToken.findMany({
    where: { userId, active: true },
    select: { id: true, tokenCiphertext: true }
  });
  if (rows.length === 0) return { configured: true, sent: 0, failed: 0, skipped: 0 };

  const payload = {
    notification: {
      ...(title ? { title: String(title) } : {}),
      ...(body ? { body: String(body) } : {})
    },
    data: stringifyData(data)
  };
  // FCM rejects a message with neither a notification nor data payload.
  if (!payload.notification.title && !payload.notification.body && Object.keys(payload.data).length === 0) {
    return { configured: true, sent: 0, failed: 0, skipped: rows.length };
  }

  let sent = 0;
  let failed = 0;
  const deadIds = [];

  await Promise.all(
    rows.map(async (row) => {
      let token;
      try {
        token = decryptToken(row.tokenCiphertext);
      } catch (error) {
        logger.warn({ error, tokenId: row.id }, 'Push token could not be decrypted; skipping');
        failed++;
        return;
      }
      try {
        await client.send({ token, ...payload });
        sent++;
      } catch (error) {
        failed++;
        if (isDeadToken(error)) {
          deadIds.push(row.id);
        } else {
          logger.warn({ error, tokenId: row.id }, 'FCM send failed');
        }
      }
    })
  );

  if (deadIds.length > 0) {
    // Revoke in one statement; best-effort (a failure here only means we retry
    // the dead token next time).
    try {
      await prisma.devicePushToken.updateMany({
        where: { id: { in: deadIds } },
        data: { active: false, revokedAt: new Date() }
      });
      logger.info({ userId, count: deadIds.length }, 'Revoked dead FCM tokens');
    } catch (error) {
      logger.warn({ error, userId }, 'Failed to revoke dead FCM tokens');
    }
  }

  return { configured: true, sent, failed, skipped: 0 };
};

export default { isPushConfigured, sendToUser };
