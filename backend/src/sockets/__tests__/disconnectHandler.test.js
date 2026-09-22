import { jest } from '@jest/globals';

const mockPrisma = {
  match: {
    findUnique: jest.fn()
  }
};

const mockRedis = {
  zrem: jest.fn(),
  zadd: jest.fn()
};

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
};

jest.unstable_mockModule('../../utils/db.js', () => ({
  default: mockPrisma
}));

jest.unstable_mockModule('../../utils/redis.js', () => ({
  default: mockRedis
}));

jest.unstable_mockModule('../../utils/logger.js', () => ({
  default: mockLogger
}));

jest.unstable_mockModule('../gameManager.js', () => ({
  getActiveGameForUser: jest.fn(),
  getGameState: jest.fn(),
  authoritativeNowMs: jest.fn(async () => 123456)
}));

jest.unstable_mockModule('../gameRecovery.js', () => ({
  reconcileRedisWithDurable: jest.fn()
}));

jest.unstable_mockModule('../connectionEvidence.js', () => ({
  recordConnectionEvent: jest.fn(),
  recordGameEvent: jest.fn()
}));

jest.unstable_mockModule('../../modules/engine/index.js', () => ({
  getLegalMoves: jest.fn(() => [])
}));

jest.unstable_mockModule('../index.js', () => ({
  getIO: jest.fn()
}));

jest.unstable_mockModule('../../modules/notification/service.js', () => ({
  NotificationService: { create: jest.fn() }
}));

const { handleJoinMatch, handleDisconnect } = await import('../disconnectHandler.js');
const { reconcileRedisWithDurable } = await import('../gameRecovery.js');
const { getIO } = await import('../index.js');
const { getActiveGameForUser, getGameState } = await import('../gameManager.js');
const { recordConnectionEvent, recordGameEvent } = await import('../connectionEvidence.js');
const { NotificationService } = await import('../../modules/notification/service.js');

const makeSocket = (overrides = {}) => {
  const socket = {
    user: { userId: 'user-1' },
    rooms: new Set(['user:user-1']),
    join: jest.fn(),
    emit: jest.fn(),
    to: jest.fn().mockReturnValue({ emit: jest.fn() }),
    ...overrides
  };
  return socket;
};

const liveMatch = (overrides = {}) => ({
  status: 'IN_PLAY',
  playerLightId: 'user-1',
  playerDarkId: 'user-2',
  ...overrides
});

describe('handleJoinMatch room membership authorization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.match.findUnique.mockResolvedValue(liveMatch());
    reconcileRedisWithDurable.mockResolvedValue({ board: '[]', currentTurn: 'white' });
  });

  it('authorizes membership BEFORE joining the room, redacting the grace marker, or notifying', async () => {
    const socket = makeSocket();

    await handleJoinMatch(socket, { matchId: 'match-1' });

    expect(socket.join).toHaveBeenCalledWith('match:match-1');
    expect(mockRedis.zrem).toHaveBeenCalledWith('disconnects', 'match-1:user-1');
    expect(socket.emit).toHaveBeenCalledWith('game_state', expect.objectContaining({
      board: '[]', currentTurn: 'white'
    }));
    expect(socket.to).toHaveBeenCalledWith('match:match-1');
    expect(socket.to('match:match-1').emit).toHaveBeenCalledWith('opponent_reconnected', {
      userId: 'user-1'
    });
  });

  it('denies an outsider: no room membership, no state, no reconnect broadcast', async () => {
    const socket = makeSocket({ user: { userId: 'user-3' } });

    await handleJoinMatch(socket, { matchId: 'match-1' });

    expect(socket.emit).toHaveBeenCalledWith('error', { message: 'Not a participant' });
    expect(socket.join).not.toHaveBeenCalled();
    expect(mockRedis.zrem).not.toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalledWith('game_state', expect.anything());
    expect(socket.to).not.toHaveBeenCalled();
  });

  it('rejects an unknown match id without mutating presence or the reconnect set', async () => {
    mockPrisma.match.findUnique.mockResolvedValue(null);
    const socket = makeSocket();

    await handleJoinMatch(socket, { matchId: 'match-zzz' });

    expect(socket.emit).toHaveBeenCalledWith('error', { message: 'Match not found' });
    expect(socket.join).not.toHaveBeenCalled();
    expect(mockRedis.zrem).not.toHaveBeenCalled();
  });

  it('enforces a per-connection room budget', async () => {
    const socket = makeSocket({ rooms: new Set(['user:user-1', 'match:a', 'match:b', 'match:c', 'match:d']) });

    await handleJoinMatch(socket, { matchId: 'match-1' });

    expect(socket.emit).toHaveBeenCalledWith('error', { message: 'Too many rooms' });
    expect(socket.join).not.toHaveBeenCalled();
    expect(mockRedis.zrem).not.toHaveBeenCalled();
  });

  it('lets a participant join a settled match to view state but emits no reconnection notification', async () => {
    mockPrisma.match.findUnique.mockResolvedValue(liveMatch({ status: 'COMPLETED' }));
    const socket = makeSocket();

    await handleJoinMatch(socket, { matchId: 'match-1' });

    expect(socket.join).toHaveBeenCalledWith('match:match-1');
    expect(socket.emit).toHaveBeenCalledWith('game_state', expect.anything());
    expect(socket.to).not.toHaveBeenCalled();
  });

  it('broadcasts a reconnection for a legacy ACTIVE match (pre-refactor value)', async () => {
    mockPrisma.match.findUnique.mockResolvedValue(liveMatch({ status: 'ACTIVE' }));
    const socket = makeSocket();

    await handleJoinMatch(socket, { matchId: 'match-1' });

    expect(socket.to('match:match-1').emit).toHaveBeenCalledWith('opponent_reconnected', {
      userId: 'user-1'
    });
  });

  it('replies Game not found when state is gone and never broadcasts a reconnect', async () => {
    reconcileRedisWithDurable.mockResolvedValue(null);
    const socket = makeSocket();

    await handleJoinMatch(socket, { matchId: 'match-1' });

    expect(socket.emit).toHaveBeenCalledWith('error', { message: 'Game not found' });
    expect(socket.to).not.toHaveBeenCalled();
  });

  it('serves the canonical match.state with the official clock and records the reconnect', async () => {
    reconcileRedisWithDurable.mockResolvedValue({
      board: JSON.stringify(new Array(50).fill(0)),
      currentTurn: 'WHITE',
      status: 'in_progress',
      version: '4',
      deadlineAt: '200000',
      turnStartedAtServer: '140000',
      disconnectGraceMs: '45000'
    });
    const socket = makeSocket();

    await handleJoinMatch(socket, { matchId: 'match-1' });

    const canonical = socket.emit.mock.calls.find(([e]) => e === 'match.state')?.[1];
    expect(canonical).toMatchObject({
      matchId: 'match-1',
      version: '4',
      turnStartedAtServer: 140000,
      serverNowMs: 123456,
      remainingMs: 76544,
      disconnectGraceMs: 45000
    });
    expect(recordConnectionEvent).toHaveBeenCalledWith(expect.objectContaining({
      matchId: 'match-1', userId: 'user-1', state: 'RECONNECTED'
    }));
  });
});

describe('handleDisconnect last-socket grace', () => {
  const makeIo = (remainingSockets) => ({
    in: jest.fn().mockReturnValue({
      fetchSockets: jest.fn().mockResolvedValue(remainingSockets)
    })
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedis.zadd.mockResolvedValue(1);
    getActiveGameForUser.mockResolvedValue('match-1');
    getGameState.mockResolvedValue({ disconnectGraceMs: '45000' });
    getIO.mockReturnValue(makeIo([]));
  });

  it('starts a snapshotted grace timer, warns the opponent and records evidence', async () => {
    const socket = makeSocket();

    await handleDisconnect(socket);

    expect(mockRedis.zadd).toHaveBeenCalledWith('disconnects', expect.any(Number), 'match-1:user-1');
    const score = mockRedis.zadd.mock.calls[0][1];
    expect(score).toBeGreaterThan(Date.now() + 40000);
    expect(socket.to('match:match-1').emit).toHaveBeenCalledWith('opponent_disconnected', {
      userId: 'user-1',
      gracePeriodMs: 45000
    });
    expect(recordConnectionEvent).toHaveBeenCalledWith(expect.objectContaining({
      matchId: 'match-1', userId: 'user-1', state: 'DISCONNECTED'
    }));
    expect(recordGameEvent).toHaveBeenCalledWith(expect.objectContaining({
      matchId: 'match-1', type: 'DISCONNECT', payload: { graceMs: 45000 }
    }));
    expect(NotificationService.create).toHaveBeenCalled();
  });

  it('ignores a vanishing socket when another socket for the user is still connected', async () => {
    getIO.mockReturnValue(makeIo([{ user: { userId: 'user-1' } }]));

    await handleDisconnect(makeSocket());

    expect(mockRedis.zadd).not.toHaveBeenCalled();
    expect(recordConnectionEvent).not.toHaveBeenCalled();
  });

  it('does nothing when the user is not in an active match', async () => {
    getActiveGameForUser.mockResolvedValue(null);

    await handleDisconnect(makeSocket());

    expect(mockRedis.zadd).not.toHaveBeenCalled();
  });
});