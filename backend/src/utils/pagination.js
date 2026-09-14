// Bounded pagination parser. All list endpoints must cap page size so a client
// can never force an unbounded `take`/`skip` against the database.
export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

const parsePositiveInt = (raw) => {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
};

/**
 * Parses `page`/`limit` query params, bounded 1..maxLimit.
 * @returns {{ok: true, data: {page: number, limit: number}} |
 *           {ok: false}}
 */
export const parsePagination = (query, { maxLimit = MAX_PAGE_LIMIT, defaultLimit = DEFAULT_PAGE_LIMIT } = {}) => {
  let page = 1;
  if (query.page !== undefined && query.page !== '') {
    const parsed = parsePositiveInt(query.page);
    if (parsed === null) return { ok: false };
    page = parsed;
  }

  let limit = defaultLimit;
  if (query.limit !== undefined && query.limit !== '') {
    const parsed = parsePositiveInt(query.limit);
    if (parsed === null || parsed > maxLimit) return { ok: false };
    limit = parsed;
  }

  return { ok: true, data: { page, limit } };
};
