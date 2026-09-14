import { describe, it, expect } from '@jest/globals';
import { parsePagination, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '../pagination.js';

describe('parsePagination', () => {
  it('applies safe defaults when no params are present', () => {
    expect(parsePagination({})).toEqual({
      ok: true,
      data: { page: 1, limit: DEFAULT_PAGE_LIMIT }
    });
  });

  it('parses valid explicit page and limit', () => {
    expect(parsePagination({ page: '3', limit: '50' })).toEqual({
      ok: true,
      data: { page: 3, limit: 50 }
    });
  });

  it('rejects an oversized limit (unbounded page size is forbidden)', () => {
    expect(parsePagination({ limit: String(MAX_PAGE_LIMIT + 1) }).ok).toBe(false);
    expect(parsePagination({ limit: '1000' }).ok).toBe(false);
  });

  it('rejects zero, negative, non-integer limits and pages', () => {
    expect(parsePagination({ limit: '0' }).ok).toBe(false);
    expect(parsePagination({ limit: '-5' }).ok).toBe(false);
    expect(parsePagination({ limit: 'abc' }).ok).toBe(false);
    expect(parsePagination({ limit: '1.5' }).ok).toBe(false);
    expect(parsePagination({ page: '0' }).ok).toBe(false);
    expect(parsePagination({ page: '-1' }).ok).toBe(false);
    expect(parsePagination({ page: 'x' }).ok).toBe(false);
  });

  it('honours a custom maxLimit', () => {
    expect(parsePagination({ limit: '25' }, { maxLimit: 25 })).toEqual({
      ok: true,
      data: { page: 1, limit: 25 }
    });
    expect(parsePagination({ limit: '26' }, { maxLimit: 25 }).ok).toBe(false);
  });

  it('treats an empty param as absent', () => {
    expect(parsePagination({ limit: '', page: '' })).toEqual({
      ok: true,
      data: { page: 1, limit: DEFAULT_PAGE_LIMIT }
    });
  });
});