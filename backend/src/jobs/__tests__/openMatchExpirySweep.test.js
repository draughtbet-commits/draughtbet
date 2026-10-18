import { jest } from '@jest/globals';

const transitionMatch = jest.fn();
jest.unstable_mockModule('../../modules/match/service.js', () => ({
  transitionMatch
}));

jest.unstable_mockModule('../../modules/v2/lifecycleService.js', () => ({
  OPEN_MATCH_TTL_MS: 15 * 60 * 1000
}));

const clearPrePlayState = jest.fn(async () => undefined);
const notifyPrePlayReleased = jest.fn();
jest.unstable_mockModule('../../sockets/prePlayNotifier.js', () => ({
  clearPrePlayState,
  notifyPrePlayReleased
}));

const findUnique = jest.fn();
const prisma = {
  match: { findMany: jest.fn() },
  $transaction: jest.fn(async (fn) => fn({ match: { findUnique } }))
};
jest.unstable_mockModule('../../utils/db.js', () => ({ default: prisma }));

const logger = (await import('../../utils/logger.js')).default;
jest.spyOn(logger, 'info').mockImplementation(() => {});
jest.spyOn(logger, 'error').mockImplementation(() => {});

const { processOpenMatchExpirySweep } = await import(
  '../openMatchExpirySweep.js'
);

describe('processOpenMatchExpirySweep', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(async (fn) =>
      fn({ match: { findUnique } }),
    );
  });

  it('scans stale OPEN listings with no pending challenge', async () => {
    prisma.match.findMany.mockResolvedValue([]);

    const result = await processOpenMatchExpirySweep({ now, ttlMs: 900000 });

    expect(prisma.match.findMany).toHaveBeenCalledWith({
      where: {
        status: 'OPEN',
        createdAt: { lt: new Date(now - 900000) },
        challenges: { none: { status: 'PENDING' } }
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
      select: { id: true, playerLightId: true, playerDarkId: true }
    });
    expect(result).toEqual({ scanned: 0, expired: 0 });
  });

  it('expires a stale listing and notifies the creator', async () => {
    prisma.match.findMany.mockResolvedValue([
      { id: 'match-1', playerLightId: 'creator-1', playerDarkId: '' }
    ]);
    findUnique.mockResolvedValue({ status: 'OPEN' });

    const result = await processOpenMatchExpirySweep({ now });

    expect(transitionMatch).toHaveBeenCalledWith(
      { match: { findUnique } },
      'match-1',
      'EXPIRED',
    );
    expect(clearPrePlayState).toHaveBeenCalledWith('match-1', [
      'creator-1',
      ''
    ]);
    expect(notifyPrePlayReleased).toHaveBeenCalledWith(
      expect.objectContaining({
        matchId: 'match-1',
        reason: 'open_match_expired',
        status: 'EXPIRED',
        refunded: false
      }),
    );
    expect(result).toEqual({ scanned: 1, expired: 1 });
  });

  it('skips a listing that is no longer OPEN', async () => {
    prisma.match.findMany.mockResolvedValue([
      { id: 'match-1', playerLightId: 'creator-1', playerDarkId: 'joiner-1' }
    ]);
    findUnique.mockResolvedValue({ status: 'FUNDED' });

    const result = await processOpenMatchExpirySweep({ now });

    expect(transitionMatch).not.toHaveBeenCalled();
    expect(notifyPrePlayReleased).not.toHaveBeenCalled();
    expect(result.expired).toBe(0);
  });

  it('keeps sweeping when one listing fails', async () => {
    prisma.match.findMany.mockResolvedValue([
      { id: 'match-1', playerLightId: 'a', playerDarkId: '' },
      { id: 'match-2', playerLightId: 'b', playerDarkId: '' }
    ]);
    prisma.$transaction
      .mockImplementationOnce(async () => {
        throw new Error('boom');
      })
      .mockImplementationOnce(async (fn) => fn({ match: { findUnique } }));
    findUnique.mockResolvedValue({ status: 'OPEN' });

    const result = await processOpenMatchExpirySweep({ now });

    expect(result).toEqual({ scanned: 2, expired: 1 });
    expect(logger.error).toHaveBeenCalled();
  });
});
