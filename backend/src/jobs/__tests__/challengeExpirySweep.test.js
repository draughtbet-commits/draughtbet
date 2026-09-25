import { jest } from '@jest/globals';

const transitionMatch = jest.fn();
jest.unstable_mockModule('../../modules/match/service.js', () => ({
  transitionMatch
}));

jest.unstable_mockModule('../../modules/v2/lifecycleService.js', () => ({
  OPEN_MATCH_TTL_MS: 900000
}));

const findMany = jest.fn();
const tx = {
  match: { findUnique: jest.fn() },
  matchChallenge: { updateMany: jest.fn() }
};
const transaction = jest.fn(async (fn) => fn(tx));
const mockPrisma = {
  matchChallenge: { findMany },
  $transaction: transaction
};
jest.unstable_mockModule('../../utils/db.js', () => ({
  default: mockPrisma
}));

const logger = (await import('../../utils/logger.js')).default;
jest.spyOn(logger, 'info').mockImplementation(() => {});
jest.spyOn(logger, 'error').mockImplementation(() => {});

const { processChallengeExpirySweep } = await import('../challengeExpirySweep.js');

describe('processChallengeExpirySweep', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('scans pending challenges created before the open-match TTL', async () => {
    findMany.mockResolvedValue([]);

    const result = await processChallengeExpirySweep({ now, ttlMs: 900000 });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        status: 'PENDING',
        createdAt: { lt: new Date(now - 900000) }
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
      select: { id: true, matchId: true }
    });
    expect(result).toEqual({ scanned: 0, expired: 0 });
  });

  it('expires an OPEN match and its pending challenge', async () => {
    findMany.mockResolvedValue([{ id: 'ch-1', matchId: 'match-1' }]);
    tx.match.findUnique.mockResolvedValue({ status: 'OPEN' });
    tx.matchChallenge.updateMany.mockResolvedValue({ count: 1 });

    const result = await processChallengeExpirySweep({ now });

    expect(tx.match.findUnique).toHaveBeenCalledWith({
      where: { id: 'match-1' },
      select: { status: true }
    });
    expect(transitionMatch).toHaveBeenCalledWith(tx, 'match-1', 'EXPIRED');
    expect(tx.matchChallenge.updateMany).toHaveBeenCalledWith({
      where: { matchId: 'match-1', status: 'PENDING' },
      data: { status: 'EXPIRED' }
    });
    expect(result).toEqual({ scanned: 1, expired: 1 });
  });

  it('skips a challenge whose match is no longer OPEN', async () => {
    findMany.mockResolvedValue([{ id: 'ch-1', matchId: 'match-1' }]);
    tx.match.findUnique.mockResolvedValue({ status: 'FUNDED' });

    const result = await processChallengeExpirySweep({ now });

    expect(transitionMatch).not.toHaveBeenCalled();
    expect(tx.matchChallenge.updateMany).not.toHaveBeenCalled();
    expect(result.expired).toBe(0);
  });

  it('keeps sweeping when one match fails', async () => {
    findMany.mockResolvedValue([
      { id: 'ch-1', matchId: 'match-1' },
      { id: 'ch-2', matchId: 'match-2' }
    ]);
    transaction.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    transaction.mockImplementationOnce(async (fn) => fn(tx));
    tx.match.findUnique.mockResolvedValue({ status: 'OPEN' });

    const result = await processChallengeExpirySweep({ now });

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalled();
    expect(result).toEqual({ scanned: 2, expired: 1 });
  });
});