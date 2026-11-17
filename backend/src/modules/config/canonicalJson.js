import crypto from 'node:crypto';

/**
 * Deterministically serializes a JavaScript value to canonical JSON according
 * to RFC 8785 (JSON Canonicalization Scheme / JCS).
 *
 * Invariants:
 * - All object keys are sorted lexicographically (UTF-16 code units).
 * - Strings are NFC normalized.
 * - Zero extraneous whitespace (no newlines, indentations, or extra spaces).
 * - Finite numbers only (no NaN, Infinity, -Infinity).
 * - Strict type preservation.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalizeJson(value) {
  if (value === null) {
    return 'null';
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Cannot canonicalize non-finite number: ${value}`);
    }
    // RFC 8785 handles -0 as 0
    if (Object.is(value, -0)) {
      return '0';
    }
    return JSON.stringify(value);
  }

  if (typeof value === 'string') {
    return JSON.stringify(value.normalize('NFC'));
  }

  if (typeof value === 'bigint') {
    // BigInt serialized as string representation
    return JSON.stringify(value.toString());
  }

  if (Array.isArray(value)) {
    const elements = value.map((item) => {
      const serialized = canonicalizeJson(item);
      return serialized === undefined ? 'null' : serialized;
    });
    return `[${elements.join(',')}]`;
  }

  if (typeof value === 'object') {
    // Exclude functions and symbols
    const sortedKeys = Object.keys(value)
      .filter((k) => typeof value[k] !== 'function' && typeof value[k] !== 'symbol' && value[k] !== undefined)
      .sort();

    const pairs = sortedKeys.map((key) => {
      const k = JSON.stringify(key.normalize('NFC'));
      const v = canonicalizeJson(value[key]);
      return `${k}:${v}`;
    });

    return `{${pairs.join(',')}}`;
  }

  throw new TypeError(`Cannot canonicalize unsupported type: ${typeof value}`);
}

/**
 * Computes the SHA-256 checksum of a value after RFC 8785 canonicalization.
 * Returns a 64-character lowercase hexadecimal hash.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function generateChecksum(value) {
  const canonicalString = canonicalizeJson(value);
  return crypto.createHash('sha256').update(canonicalString, 'utf8').digest('hex');
}

/**
 * Verifies that the canonical checksum of a value matches an expected checksum.
 * Uses timing-safe equality comparison.
 *
 * @param {unknown} value
 * @param {string} expectedChecksum
 * @returns {boolean}
 */
export function verifyChecksum(value, expectedChecksum) {
  if (typeof expectedChecksum !== 'string' || expectedChecksum.length !== 64) {
    return false;
  }
  const actualChecksum = generateChecksum(value);
  const bufA = Buffer.from(actualChecksum, 'hex');
  const bufB = Buffer.from(expectedChecksum, 'hex');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

