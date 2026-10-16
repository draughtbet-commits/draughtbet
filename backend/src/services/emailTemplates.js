/**
 * Pure email templates. Each builder takes plain data and returns
 * `{ subject, text, html }` — no I/O, so they are trivial to unit-test. The HTML
 * is intentionally minimal (inline styles, no remote assets) so it renders in
 * every client; `text` is always provided for accessibility and deliverability.
 */

const BRAND = 'Draught Bet';
const FOOTER =
  'You are receiving this because you have a Draught Bet account. ' +
  'If this was not you, please secure your account immediately.';

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const layout = ({ heading, bodyHtml }) => `<!doctype html>
<html><body style="margin:0;padding:0;background:#0f1115;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:24px;">
    <h1 style="color:#f5c451;font-size:20px;margin:0 0 16px;">${escapeHtml(BRAND)}</h1>
    <div style="background:#181b22;border-radius:12px;padding:24px;color:#e8eaf0;font-size:15px;line-height:1.6;">
      <h2 style="margin:0 0 12px;font-size:18px;color:#ffffff;">${escapeHtml(heading)}</h2>
      ${bodyHtml}
    </div>
    <p style="color:#7a8091;font-size:12px;line-height:1.5;margin:16px 0 0;">${escapeHtml(FOOTER)}</p>
  </div>
</body></html>`;

const p = (text) => `<p style="margin:0 0 12px;">${escapeHtml(text)}</p>`;

const greeting = (name) => (name ? `Hi ${name},` : 'Hi,');

/**
 * Welcome / sign-up confirmation, sent once when an account is created.
 */
export const welcomeEmail = ({ name } = {}) => {
  const lines = [
    greeting(name),
    `Your ${BRAND} account is ready. You can sign in, verify your contact details, add money to your wallet and start playing draughts for real stakes.`,
    'Play smart. Compete fairly.'
  ];
  return {
    subject: `Welcome to ${BRAND}`,
    text: lines.join('\n\n'),
    html: layout({
      heading: `Welcome to ${BRAND}`,
      bodyHtml: `${p(greeting(name))}${p(`Your ${BRAND} account is ready. You can sign in, verify your contact details, add money to your wallet and start playing draughts for real stakes.`)}${p('Play smart. Compete fairly.')}`
    })
  };
};

/**
 * Security alert sent after the password is changed (e.g. via reset).
 */
export const passwordChangedEmail = ({ name } = {}) => {
  const lines = [
    greeting(name),
    'Your password has been changed. If you did this, no action is needed.',
    'If you did not change your password, reset it immediately and contact support.'
  ];
  return {
    subject: `Your ${BRAND} password was changed`,
    text: lines.join('\n\n'),
    html: layout({
      heading: 'Your password was changed',
      bodyHtml: `${p(greeting(name))}${p('Your password has been changed. If you did this, no action is needed.')}${p('If you did not change your password, reset it immediately and contact support.')}`
    })
  };
};

/**
 * KYC approved.
 */
export const kycVerifiedEmail = ({ name } = {}) => {
  const lines = [
    greeting(name),
    'Your identity verification is complete. Your account is now fully verified.'
  ];
  return {
    subject: `Your ${BRAND} identity verification is complete`,
    text: lines.join('\n\n'),
    html: layout({
      heading: 'Identity verified',
      bodyHtml: `${p(greeting(name))}${p('Your identity verification is complete. Your account is now fully verified.')}`
    })
  };
};

/**
 * KYC rejected, with the provider/admin reason when available. Rejection is not
 * a ban — the player is invited to try again.
 */
export const kycRejectedEmail = ({ name, reason } = {}) => {
  const reasonLine = reason ? `Reason: ${reason}` : null;
  const lines = [
    greeting(name),
    'We could not verify your identity with the documents provided.',
    ...(reasonLine ? [reasonLine] : []),
    'You can start the verification again from your profile with a clear photo of a valid document.'
  ];
  return {
    subject: `Action needed: ${BRAND} identity verification`,
    text: lines.join('\n\n'),
    html: layout({
      heading: 'Identity verification needs another try',
      bodyHtml: `${p(greeting(name))}${p('We could not verify your identity with the documents provided.')}${reasonLine ? p(reasonLine) : ''}${p('You can start the verification again from your profile with a clear photo of a valid document.')}`
    })
  };
};

/**
 * Generic email that mirrors an in-app notification (money receipts, account
 * status). The notification already carries a human title/message built from the
 * authoritative ledger/state, so the email never re-derives amounts.
 */
export const notificationEmail = ({ name, title, message } = {}) => {
  const lines = [greeting(name), message].filter(Boolean);
  return {
    subject: title ? `${BRAND}: ${title}` : `${BRAND} update`,
    text: lines.join('\n\n'),
    html: layout({
      heading: title || `${BRAND} update`,
      bodyHtml: `${p(greeting(name))}${p(message)}`
    })
  };
};

export default {
  welcomeEmail,
  passwordChangedEmail,
  kycVerifiedEmail,
  kycRejectedEmail,
  notificationEmail
};
