import { jest } from '@jest/globals';
import {
  validateMoveAttempt,
  validateMatchIdPayload,
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
});