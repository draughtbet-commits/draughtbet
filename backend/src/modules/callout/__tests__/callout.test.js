import { jest } from '@jest/globals';

const mockPrisma = {
  $executeRaw: jest.fn(),
  callout: {
    findUnique: jest.fn(),
    create: jest.fn(),
    findMany: jest.fn()
  },
  user: {
    findUnique: jest.fn()
  }
};

jest.unstable_mockModule('../../../utils/db.js', () => ({
  default: mockPrisma
}));

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
};

jest.unstable_mockModule('../../../utils/logger.js', () => ({
  default: mockLogger
}));

const mockDebitStakes = jest.fn();
jest.unstable_mockModule('../../../services/matchService.js', () => ({
  debitStakes: mockDebitStakes
}));

const mockInitializeGame = jest.fn();
jest.unstable_mockModule('../../../sockets/gameManager.js', () => ({
  initializeGame: mockInitializeGame
}));

const mockEmit = jest.fn();
const mockTo = jest.fn().mockReturnValue({ emit: mockEmit });
jest.unstable_mockModule('../../../sockets/index.js', () => ({
  getIO: jest.fn(() => ({
    emit: mockEmit,
    to: mockTo
  }))
}));

describe('callout service', () => {
  let calloutService;

  beforeAll(async () => {
    calloutService = await import('../service.js');
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should conditionally accept a callout and invoke debitStakes', async () => {
    // Simulate successful conditional update (1 row updated)
    mockPrisma.$executeRaw.mockResolvedValueOnce(1);

    mockPrisma.callout.findUnique.mockResolvedValueOnce({
      id: 'callout-1',
      challengerId: 'player-1',
      tier: 'PRO',
      stakeMinorUnits: 1000000n
    });

    mockDebitStakes.mockResolvedValueOnce({
      id: 'match-1',
      stakeMinorUnits: 1000000n
    });

    const payload = await calloutService.acceptCallout('player-2', 'callout-1');

    // Asserts conditional update syntax
    expect(mockPrisma.$executeRaw).toHaveBeenCalled();
    // Asserts debitStakes is called correctly
    expect(mockDebitStakes).toHaveBeenCalledWith('player-1', 'player-2', 1000000n, 'PRO');
    // Asserts initializeGame is called
    expect(mockInitializeGame).toHaveBeenCalledWith('match-1', 'player-1', 'player-2', 'PRO');
    // Asserts socket notification is sent to both users
    expect(mockTo).toHaveBeenCalledWith('user:player-1');
    expect(mockTo).toHaveBeenCalledWith('user:player-2');
    expect(mockEmit).toHaveBeenCalledWith('match_found', expect.any(Object));
    expect(payload).toBeDefined();
  });

  it('should return null if the conditional update fails (0 rows affected)', async () => {
    // Simulate someone else accepted it (0 rows updated)
    mockPrisma.$executeRaw.mockResolvedValueOnce(0);

    const payload = await calloutService.acceptCallout('player-2', 'callout-1');

    expect(payload).toBeNull();
    expect(mockPrisma.callout.findUnique).not.toHaveBeenCalled();
    expect(mockDebitStakes).not.toHaveBeenCalled();
  });
});
