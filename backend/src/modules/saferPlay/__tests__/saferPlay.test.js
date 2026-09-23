import { jest } from '@jest/globals';
import { effectiveValue } from '../service.js';

describe('safePlay effectiveValue helper', () => {
  it('returns null when base and pending are both null', () => {
    expect(effectiveValue(null, null, null, new Date(), 24)).toBeNull();
  });

  it('returns base when there is no pending', () => {
    expect(effectiveValue(500n, null, null, new Date(), 24)).toBe(500n);
  });

  it('returns base when pending is within cooling', () => {
    const now = new Date('2026-01-01T12:00:00Z');
    const raisedAt = new Date('2026-01-01T11:00:00Z'); // 1h ago, need 24h
    expect(effectiveValue(500n, 1000n, raisedAt, now, 24)).toBe(500n);
  });

  it('returns pending once cooling has elapsed', () => {
    const now = new Date('2026-01-01T12:00:00Z');
    const raisedAt = new Date('2026-01-01T11:00:00Z');
    expect(effectiveValue(500n, 1000n, raisedAt, now, 1)).toBe(1000n);
  });

  it('returns pending once cooling has elapsed even when base was null', () => {
    const now = new Date('2026-01-01T12:00:00Z');
    const raisedAt = new Date('2026-01-01T11:00:00Z');
    expect(effectiveValue(null, 1000n, raisedAt, now, 1)).toBe(1000n);
  });
});
