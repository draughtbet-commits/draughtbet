import { jest } from '@jest/globals';

const fundOpenMatch = jest.fn();
jest.unstable_mockModule('../../modules/v2/lifecycleService.js', () => ({
  fundOpenMatch,
  OPEN_MATCH_TTL_MS: 900000
}));

const findMany = jest.fn();
const findFirst = jest.fn();
const findUnique = jest.fn();
const mockPrisma = {
  match: { findMany },
  matchChallenge: { findFirst },
  gameOutbox: { findUnique }
};
jest.unstable_mockModule('../../utils/db.js', () => ({
  default: mockPrisma
}));

const debitStakes = jest.fn();
jest.unstable_mockModule('../../services/matchService.js', () => ({
  debitStakes,
  InsufficientFundsError: class InsufficientFundsError extends Error {},
  ActiveMatchError: class ActiveMatchError extends Error {}
}));

const finalizeMatchActivation = jest.fn();
jest.unstable_mockModule('../../services/gameActivationService.js', () => ({
  finalizeMatchActivation
}));

const emit = jest.fn();
const to = jest.fn(() => ({ emit }));
const mockIO = { to };
jest.unstable_mockModule('../../sockets/index.js', () => ({
  getIO: () => mockIO
}));

const create = jest.fn();
jest.unstable_mockModule('../../modules/notification/service.js', () => ({
  NotificationService: { create }
}));

// The worker discovers live buckets via SCAN now (stakes are a free-form range,
// so there is no preset list to iterate). One bucket keeps the loop simple.
const QUEUE_KEY = 'queue:MASTER:1000000';

// The queue is a stand-in for Redis: a sorted list of waiting player ids, with
// the pop helpers mirroring the Lua scripts' behaviour.
let queue = [];
const zadd = jest.fn((key, score, member) => {
  if (!queue.includes(member)) queue.push(member);
});
const mockRedis = {
  // The worker registers its Lua commands at import time.
  defineCommand: jest.fn(),
  scan: jest.fn(async () => ['0', [QUEUE_KEY]]),
  popMatchmakingPair: jest.fn(async () => {
    if (queue.length < 2) return null;
    const pair = [queue[0], queue[1]];
    queue = queue.slice(2);
    return pair;
  }),
  popMatchmakingPlayer: jest.fn(async () => {
    if (queue.length === 0) return null;
    const player = queue[0];
    queue = queue.slice(1);
    return player;
  }),
  zadd
};
jest.unstable_mockModule('../../utils/redis.js', () => ({
  default: mockRedis,
  isRedisReady: () => true
}));

const logger = (await import('../../utils/logger.js')).default;
jest.spyOn(logger, 'info').mockImplementation(() => {});
jest.spyOn(logger, 'warn').mockImplementation(() => {});
jest.spyOn(logger, 'error').mockImplementation(() => {});

const { processMatchmakingQueues } = await import('../matchmakingWorker.js');

const QUEUED = 'queued-player';
const OWNER = 'open-match-owner';
const OPEN_MATCH = {
  id: 'match-1',
  playerLightId: OWNER,
  playerDarkId: '',
  stakeMinorUnits: 1000000n
};

describe('matchmaking worker: seating into open matches', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queue = [];
    findMany.mockResolvedValue([]);
    findFirst.mockResolvedValue(null);
    findUnique.mockResolvedValue(null);
    finalizeMatchActivation.mockResolvedValue(undefined);
    debitStakes.mockResolvedValue({ id: 'queued-match' });
  });

  it('seats a waiting player into a compatible open match', async () => {
    queue = [QUEUED];
    findMany.mockResolvedValue([OPEN_MATCH]);
    fundOpenMatch.mockResolvedValue({
      id: 'match-1',
      playerLightId: OWNER,
      playerDarkId: QUEUED,
      stakeMinorUnits: 1000000n
    });

    await processMatchmakingQueues();

    expect(fundOpenMatch).toHaveBeenCalledWith(QUEUED, 'match-1', { tier: 'MASTER' });
    // The match is announced to both players, not just the one who queued.
    expect(mockIO.to).toHaveBeenCalledWith(`user:${OWNER}`);
    expect(mockIO.to).toHaveBeenCalledWith(`user:${QUEUED}`);
    expect(emit).toHaveBeenCalledWith(
      'match_found',
      expect.objectContaining({ id: 'match-1' })
    );
  });

  it('does not seat the owner of an open match into their own match', async () => {
    queue = [OWNER];
    findMany.mockResolvedValue([OPEN_MATCH]);

    await processMatchmakingQueues();

    expect(fundOpenMatch).not.toHaveBeenCalled();
    // And the owner stays queued rather than being silently dropped.
    expect(queue).toContain(OWNER);
  });

  it('ignores an open match that is a pending directed challenge', async () => {
    queue = [QUEUED];
    findMany.mockResolvedValue([OPEN_MATCH]);
    // A pending challenge means the seat is reserved for someone specific.
    findFirst.mockResolvedValue({ id: 'c1', inviteeId: 'someone-else' });

    await processMatchmakingQueues();

    expect(fundOpenMatch).not.toHaveBeenCalled();
  });

  it('leaves the waiting player queued and reports the failure when funding fails', async () => {
    queue = [QUEUED];
    findMany.mockResolvedValue([OPEN_MATCH]);
    fundOpenMatch.mockRejectedValue(new Error('Insufficient funds'));

    await processMatchmakingQueues();

    expect(emit).toHaveBeenCalledWith('error', { message: 'Insufficient funds' });
    // The player is told, not left in a silent search that never resolves.
    expect(mockIO.to).toHaveBeenCalledWith(`user:${QUEUED}`);
  });

  it('still pairs two queued players when there is no open match', async () => {
    queue = ['p1', 'p2'];
    findMany.mockResolvedValue([]);

    await processMatchmakingQueues();

    expect(debitStakes).toHaveBeenCalledWith('p1', 'p2', 1000000n, 'MASTER');
    expect(fundOpenMatch).not.toHaveBeenCalled();
  });
});