import { canonicalizeJson, generateChecksum, verifyChecksum } from '../canonicalJson.js';

describe('canonicalJson', () => {
  it('deterministically sorts object keys regardless of original insertion order', () => {
    const objA = { z: 1, a: 2, m: { y: 'bar', x: 'foo' } };
    const objB = { a: 2, m: { x: 'foo', y: 'bar' }, z: 1 };

    expect(canonicalizeJson(objA)).toBe(canonicalizeJson(objB));
    expect(canonicalizeJson(objA)).toBe('{"a":2,"m":{"x":"foo","y":"bar"},"z":1}');
  });

  it('serializes numbers, strings, booleans, and null properly', () => {
    expect(canonicalizeJson(null)).toBe('null');
    expect(canonicalizeJson(true)).toBe('true');
    expect(canonicalizeJson(false)).toBe('false');
    expect(canonicalizeJson(42)).toBe('42');
    expect(canonicalizeJson(-0)).toBe('0');
    expect(canonicalizeJson('hello')).toBe('"hello"');
  });

  it('throws on non-finite numbers', () => {
    expect(() => canonicalizeJson(NaN)).toThrow(TypeError);
    expect(() => canonicalizeJson(Infinity)).toThrow(TypeError);
  });

  it('handles arrays and maintains element order', () => {
    expect(canonicalizeJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalizeJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  it('generates a 64-character lowercase hexadecimal SHA-256 hash', () => {
    const payload = { platform: 'Draught Bet', version: 1 };
    const checksum = generateChecksum(payload);

    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
    // Identical payload in different order gives identical checksum
    expect(generateChecksum({ version: 1, platform: 'Draught Bet' })).toBe(checksum);
  });

  it('detects even the slightest payload mutation during verification', () => {
    const payload = {
      financial: { commissionPercent: 10, minStake: '50000' }
    };
    const checksum = generateChecksum(payload);

    expect(verifyChecksum(payload, checksum)).toBe(true);

    const tampered = {
      financial: { commissionPercent: 11, minStake: '50000' }
    };
    expect(verifyChecksum(tampered, checksum)).toBe(false);
  });

  it('rejects invalid or malformed checksum strings safely', () => {
    expect(verifyChecksum({ a: 1 }, 'not-a-valid-checksum')).toBe(false);
    expect(verifyChecksum({ a: 1 }, null)).toBe(false);
  });
});

