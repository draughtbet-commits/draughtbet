import { jest } from '@jest/globals';
import {
  validateMoveAttempt,
  validateMoveSubmit,
  validateMatchIdPayload,
  validateClockSync,
  payloadTooLarge
} from '../payloadGuard.js';

describe('payloadGuard', () => {
  it('accepts a well-formed move attempt', () => {
    const result = validateMoveAttempt({ matchId: 'abc', from: 1, to: 6 });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ matchId: 'abc', from: 1, to: 6 });
  });

  it('accepts a well-formed match-id payload (resign/join)', () => {
    const result = validateMatchIdPayload({ matchId: 'abc' });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ matchId: 'abc' });
  });

  it('rejects null', () => {
    expect(validateMoveAttempt(null).ok).toBe(false);
    expect(validateMatchIdPayload(null).ok).toBe(false);
  });

  it('rejects omitted payloads', () => {
    expect(validateMoveAttempt(undefined).ok).toBe(false);
    expect(validateMatchIdPayload(undefined).ok).toBe(false);
  });

  it('rejects arrays', () => {
    expect(validateMoveAttempt([]).ok).toBe(false);
    expect(validateMatchIdPayload([1, 2]).ok).toBe(false);
  });

  it('rejects wrong-type fields', () => {
    expect(validateMoveAttempt({ matchId: 123, from: 1, to: 6 }).ok).toBe(false);
    expect(validateMoveAttempt({ matchId: 'abc', from: '1', to: 6 }).ok).toBe(false);
    expect(validateMoveAttempt({ matchId: 'abc', from: 1, to: 6.5 }).ok).toBe(false);
    expect(validateMatchIdPayload({ matchId: {} }).ok).toBe(false);
  });

  it('rejects out-of-bounds squares', () => {
    expect(validateMoveAttempt({ matchId: 'abc', from: 0, to: 6 }).ok).toBe(false);
    expect(validateMoveAttempt({ matchId: 'abc', from: 51, to: 6 }).ok).toBe(false);
    expect(validateMoveAttempt({ matchId: 'abc', from: 1.5, to: 6 }).ok).toBe(false);
  });

  it('rejects empty or oversized match ids', () => {
    expect(validateMatchIdPayload({ matchId: '' }).ok).toBe(false);
    expect(validateMatchIdPayload({ matchId: 'x'.repeat(65) }).ok).toBe(false);
  });

  it('rejects unknown fields (bounded schema)', () => {
    expect(validateMoveAttempt({ matchId: 'abc', from: 1, to: 6, extra: 1 }).ok).toBe(false);
    expect(validateMatchIdPayload({ matchId: 'abc', extra: 1 }).ok).toBe(false);
  });

  it('rejects oversized payloads', () => {
    const big = 'x'.repeat(5000);
    expect(validateMoveAttempt({ matchId: big, from: 1, to: 6 }).ok).toBe(false);
    expect(validateMatchIdPayload({ matchId: big }).ok).toBe(false);
    expect(payloadTooLarge({ matchId: big })).toBe(true);
  });

  it('accepts clock sync with an optional non-negative clientSentAt only', () => {
    expect(validateClockSync({ matchId: 'abc' }).ok).toBe(true);
    expect(validateClockSync({ matchId: 'abc', clientSentAt: 0 }).ok).toBe(true);
    expect(validateClockSync({ matchId: 'abc', clientSentAt: 1712345678000 }).ok).toBe(true);
    expect(validateClockSync({ matchId: 'abc', clientSentAt: -1 }).ok).toBe(false);
    expect(validateClockSync({ matchId: 'abc', clientSentAt: 1.5 }).ok).toBe(false);
    expect(validateClockSync({ matchId: 'abc', serverNowMs: 1 }).ok).toBe(false);
    expect(validateClockSync({}).ok).toBe(false);
  });
});

describe('payloadGuard — V2 move.submit', () => {
  const base = { matchId: 'abc', clientMoveId: 'cm_12345678', from: 32, to: 12 };

  it('accepts a simple move with an explicit to', () => {
    const result = validateMoveSubmit(base);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual(base);
  });

  it('accepts a multi-capture move expressed as a path without a to', () => {
    const result = validateMoveSubmit({ matchId: 'abc', clientMoveId: 'cm_12345678', from: 32, path: [32, 21, 12] });
    expect(result.ok).toBe(true);
  });

  it('accepts a full payload with expectedStateVersion and matching path', () => {
    const result = validateMoveSubmit({ ...base, expectedStateVersion: 0, path: [32, 21, 12] });
    expect(result.ok).toBe(true);
  });

  it('rejects a missing to and path', () => {
    expect(validateMoveSubmit({ matchId: 'abc', clientMoveId: 'cm_12345678', from: 32 }).ok).toBe(false);
  });

  it('rejects a path that does not start at from or end at to', () => {
    expect(validateMoveSubmit({ matchId: 'abc', clientMoveId: 'cm_12345678', from: 32, path: [31, 21, 12] }).ok).toBe(false);
    expect(validateMoveSubmit({ matchId: 'abc', clientMoveId: 'cm_12345678', from: 32, to: 11, path: [32, 21, 12] }).ok).toBe(false);
  });

  it('rejects a path with repeated squares', () => {
    expect(validateMoveSubmit({ matchId: 'abc', clientMoveId: 'cm_12345678', from: 32, path: [32, 21, 32] }).ok).toBe(false);
  });

  it('requires a valid clientMoveId', () => {
    expect(validateMoveSubmit({ matchId: 'abc', from: 32, to: 12 }).ok).toBe(false);
    expect(validateMoveSubmit({ ...base, clientMoveId: 'short' }).ok).toBe(false);
    expect(validateMoveSubmit({ ...base, clientMoveId: 'has spaces here' }).ok).toBe(false);
    expect(validateMoveSubmit({ ...base, clientMoveId: 'x'.repeat(65) }).ok).toBe(false);
  });

  it('rejects a negative or non-integer expectedStateVersion', () => {
    expect(validateMoveSubmit({ ...base, expectedStateVersion: -1 }).ok).toBe(false);
    expect(validateMoveSubmit({ ...base, expectedStateVersion: 1.5 }).ok).toBe(false);
  });

  it('rejects unknown fields (bounded schema)', () => {
    expect(validateMoveSubmit({ ...base, extra: 1 }).ok).toBe(false);
  });

  it('rejects null/undefined/array payloads', () => {
    expect(validateMoveSubmit(null).ok).toBe(false);
    expect(validateMoveSubmit(undefined).ok).toBe(false);
    expect(validateMoveSubmit([]).ok).toBe(false);
  });
});