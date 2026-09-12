import { jest } from '@jest/globals';

const mockPrisma = {
  match: {
    findUnique: jest.fn()
  }
};

const mockRedis = {
  zrem: jest.fn()
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
  getGameState: jest.fn()
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
const { getGameState } = await import('../gameManager.js');

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
  status: 'ACTIVE',
  playerLightId: 'user-1',
  playerDarkId: 'user-2',
  ...overrides
});

describe('handleJoinMatch (S04 room membership authorization)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.match.findUnique.mockResolvedValue(liveMatch());
    getGameState.mockResolvedValue({ board: '[]', currentTurn: 'white' });
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

  it('replies Game not found when state is gone and never broadcasts a reconnect', async () => {
    getGameState.mockResolvedValue(null);
    const socket = makeSocket();

    await handleJoinMatch(socket, { matchId: 'match-1' });

    expect(socket.emit).toHaveBeenCalledWith('error', { message: 'Game not found' });
    expect(socket.to).not.toHaveBeenCalled();
  });
});