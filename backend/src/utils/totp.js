import crypto from 'node:crypto';

/**
 * Pure Node.js RFC 4648 Base32 + RFC 4226 HOTP + RFC 6238 TOTP implementation
 * built exclusively on `node:crypto` with constant-time comparisons.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BASE32_LOOKUP = Object.fromEntries(
  BASE32_ALPHABET.split('').map((ch, idx) => [ch, idx])
);

export const encodeBase32 = (buffer) => {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
};

export const decodeBase32 = (base32) => {
  if (typeof base32 !== 'string') {
    throw new Error('Base32 secret must be a string');
  }
  const normalized = base32.toUpperCase().replace(/[\s=-]/g, '');
  if (!normalized) {
    throw new Error('Base32 secret is empty');
  }

  let bits = 0;
  let value = 0;
  const out = [];

  for (const ch of normalized) {
    const idx = BASE32_LOOKUP[ch];
    if (idx === undefined) {
      throw new Error(`Invalid Base32 character: ${ch}`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(out);
};

export const generateBase32Secret = (numBytes = 20) => {
  return encodeBase32(crypto.randomBytes(numBytes));
};

export const generateHotp = (base32Secret, counter, { digits = 6 } = {}) => {
  const key = decodeBase32(base32Secret);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));

  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const mod = 10 ** digits;
  return String(binary % mod).padStart(digits, '0');
};

export const generateTotp = (
  base32Secret,
  { timestamp = Date.now(), stepSeconds = 30, digits = 6 } = {}
) => {
  const step = Math.floor(timestamp / 1000 / stepSeconds);
  return generateHotp(base32Secret, step, { digits });
};

/**
 * Verifies a 6-digit RFC-6238 TOTP token with ±window steps using constant-time
 * comparison. Returns `{ valid, step }` where `step` is the matched time-step
 * counter (useful for replay protection).
 */
export const verifyTotp = (
  base32Secret,
  token,
  { timestamp = Date.now(), stepSeconds = 30, digits = 6, window = 1 } = {}
) => {
  if (typeof token !== 'string') {
    return { valid: false, step: null };
  }
  const normalized = token.replace(/\s+/g, '');
  const digitsPattern = new RegExp(`^\\d{${digits}}$`);
  if (!digitsPattern.test(normalized)) {
    return { valid: false, step: null };
  }

  const currentStep = Math.floor(timestamp / 1000 / stepSeconds);
  const providedBuf = Buffer.from(normalized, 'utf8');
  let matchedStep = null;

  for (let delta = -window; delta <= window; delta += 1) {
    const candidateStep = currentStep + delta;
    if (candidateStep < 0) continue;
    const expected = generateHotp(base32Secret, candidateStep, { digits });
    const expectedBuf = Buffer.from(expected, 'utf8');
    if (
      expectedBuf.length === providedBuf.length &&
      crypto.timingSafeEqual(expectedBuf, providedBuf)
    ) {
      matchedStep = candidateStep;
    }
  }

  return {
    valid: matchedStep !== null,
    step: matchedStep
  };
};

export const generateOtpAuthUri = ({
  issuer = 'Draught Bet Admin',
  label,
  secret,
  digits = 6,
  period = 30
}) => {
  const encodedIssuer = encodeURIComponent(issuer);
  const encodedLabel = encodeURIComponent(label);
  return `otpauth://totp/${encodedIssuer}:${encodedLabel}?secret=${encodeURIComponent(secret)}&issuer=${encodedIssuer}&algorithm=SHA1&digits=${digits}&period=${period}`;
};
