import { jest } from '@jest/globals';

const mockPrisma = {
  $queryRaw: jest.fn(),
  $transaction: jest.fn(),
  gameOutbox: {
    findUnique: jest.fn(),
    updateMany: jest.fn(),
    update: jest.fn()
  },
  wallet: { update: jest.fn() },
  ledgerAccount: { upsert: jest.fn() },
  ledgerTransaction: { create: jest.fn(), findUnique: jest.fn() },
  ledgerEntry: { create: jest.fn() },
  match: { update: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn() },
  stakeReservation: { updateMany: jest.fn() }
};

jest.unstable_mockModule('../../utils/db.js', () => ({
  default: mockPrisma
}));

const mockRedis = { exists: jest.fn() };
jest.unstable_mockModule('../../utils/redis.js', () => ({
  default: mockRedis,
  isRedisReady: jest.fn(() => true)
}));

const mockInitializeGame = jest.fn();
jest.unstable_mockModule('../../sockets/gameManager.js', () => ({
  initializeGame: mockInitializeGame,
  getGameState: jest.fn()
}));

jest.unstable_mockModule('../matchService.js', () => ({
  lockWalletsInOrder: jest.fn()
}));

const mockReleaseStakes = jest.fn();
jest.unstable_mockModule('../../modules/stake/service.js', () => ({
  releaseStakes: mockReleaseStakes
}));

const mockTransitionMatch = jest.fn();
const mockIsLiveStatus = jest.fn(() => false);
jest.unstable_mockModule('../../modules/match/service.js', () => ({
  transitionMatch: mockTransitionMatch,
  isLiveStatus: mockIsLiveStatus
}));

const { lockWalletsInOrder } = await import('../matchService.js');
const {
  finalizeMatchActivation,
  releaseMatch,
  MAX_ACTIVATION_ATTEMPTS
} = await import('../gameActivationService.js');

const pendingRow = {
  id: 'outbox-1',
  matchId: 'match-1',
  player1Id: 'player-a',
  player2Id: 'player-b',
  tier: 'AMATEUR',
  stakeMinorUnits: '5000',
  attempts: 1
};

describe('gameActivationService finalizeMatchActivation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.gameOutbox.findUnique.mockResolvedValue({ status: 'PENDING' });
    mockPrisma.$queryRaw.mockResolvedValue([pendingRow]);
    mockPrisma.gameOutbox.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.match.updateMany.mockResolvedValue({ count: 1 });
    mockInitializeGame.mockResolvedValue({});
  });

  it('skips records already activated or released', async () => {
    mockPrisma.gameOutbox.findUnique.mockResolvedValue({ status: 'ACTIVATED' });
    await expect(finalizeMatchActivation('outbox-1')).resolves.toBe('ACTIVATED');
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    expect(mockInitializeGame).not.toHaveBeenCalled();

    mockPrisma.gameOutbox.findUnique.mockResolvedValue({ status: 'RELEASED' });
    await expect(finalizeMatchActivation('outbox-1')).resolves.toBe('RELEASED');
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('reconstructs Redis for a PENDING record and marks it ACTIVATED', async () => {
    await expect(finalizeMatchActivation('outbox-1')).resolves.toBe('ACTIVATED');

    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mockInitializeGame).toHaveBeenCalledWith('match-1', 'player-a', 'player-b', 'AMATEUR');
    expect(mockPrisma.gameOutbox.updateMany).toHaveBeenCalledWith({
      where: { id: 'outbox-1', claimToken: expect.any(String) },
      data: expect.objectContaining({ status: 'ACTIVATED' })
    });
  });

  it('gives way to a competing actor holding the claim', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockPrisma.gameOutbox.findUnique
      .mockResolvedValueOnce({ status: 'PENDING' })
      .mockResolvedValueOnce({ status: 'ACTIVATING' });

    await expect(finalizeMatchActivation('outbox-1')).resolves.toBe('ACTIVATING');
    expect(mockInitializeGame).not.toHaveBeenCalled();
  });

  it('records the failure, clears the claim and does NOT debit anyone', async () => {
    mockInitializeGame.mockRejectedValue(new Error('redis unreachable'));

    await expect(finalizeMatchActivation('outbox-1')).rejects.toThrow('redis unreachable');

    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mockPrisma.gameOutbox.updateMany).toHaveBeenCalledWith({
      where: { id: 'outbox-1' },
      data: expect.objectContaining({
        claimToken: null,
        claimExpiresAt: null,
        lastError: expect.stringContaining('redis unreachable')
      })
    });
    expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
    expect(mockPrisma.match.updateMany).not.toHaveBeenCalled();
  });
});

describe('gameActivationService releaseMatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$queryRaw.mockResolvedValue([pendingRow]);
    lockWalletsInOrder.mockResolvedValue([
      { id: 'w-a', userId: 'player-a', currency: 'NGN' },
      { id: 'w-b', userId: 'player-b', currency: 'NGN' }
    ]);
    mockPrisma.$transaction.mockImplementation(async (fn) => fn(mockPrisma));
    mockTransitionMatch.mockResolvedValue({ id: 'match-1', status: 'RELEASED' });
    mockReleaseStakes.mockResolvedValue({});
  });

  it('refunds both stakes exactly once and records the release', async () => {
    const result = await releaseMatch('outbox-1');

    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(lockWalletsInOrder).toHaveBeenCalledWith(mockPrisma, 'player-a', 'player-b');
    // Release is only legal before the game is live: the transition guard runs
    // (and can throw) before any money moves; refunds go through StakeService.
    expect(mockTransitionMatch).toHaveBeenCalledWith(mockPrisma, 'match-1', 'RELEASED');
    expect(mockReleaseStakes).toHaveBeenCalledWith(mockPrisma, {
      matchId: 'match-1',
      participants: [
        { userId: 'player-a' },
        { userId: 'player-b' }
      ],
      amountMinorUnits: 5000n,
      wallets: [
        { id: 'w-a', userId: 'player-a', currency: 'NGN' },
        { id: 'w-b', userId: 'player-b', currency: 'NGN' }
      ]
    });
    expect(mockPrisma.match.update).toHaveBeenCalledWith({
      where: { id: 'match-1' },
      data: expect.objectContaining({ endReason: 'activation_failed' })
    });
    expect(mockPrisma.gameOutbox.update).toHaveBeenCalledWith({
      where: { id: 'outbox-1' },
      data: expect.objectContaining({ status: 'RELEASED' })
    });
    expect(result.released).toBe(true);
  });

  it('does nothing when it loses the claim to another actor', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([]);
    await expect(releaseMatch('outbox-1')).resolves.toBeNull();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockTransitionMatch).not.toHaveBeenCalled();
    expect(mockReleaseStakes).not.toHaveBeenCalled();
  });

  it('issues exactly one release per claim; a second attempt on the released row writes nothing', async () => {
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([pendingRow])
      .mockResolvedValueOnce([]);

    await releaseMatch('outbox-1');
    await releaseMatch('outbox-1');

    expect(mockTransitionMatch).toHaveBeenCalledTimes(1);
    expect(mockReleaseStakes).toHaveBeenCalledTimes(1);
  });
});

describe('gameActivationService limits', () => {
  it('exposes the attempt budget used to decide release vs retry', () => {
    expect(MAX_ACTIVATION_ATTEMPTS).toBeGreaterThan(0);
  });
});