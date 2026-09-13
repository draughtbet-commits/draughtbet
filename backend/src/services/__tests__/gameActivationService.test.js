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
  walletTransaction: { create: jest.fn() },
  match: { update: jest.fn() }
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
    expect(mockPrisma.walletTransaction.create).not.toHaveBeenCalled();
  });
});

describe('gameActivationService releaseMatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$queryRaw.mockResolvedValue([pendingRow]);
    lockWalletsInOrder.mockResolvedValue([
      { id: 'w-a', userId: 'player-a', balanceMinorUnits: '9000' },
      { id: 'w-b', userId: 'player-b', balanceMinorUnits: '9000' }
    ]);
  });

  it('refunds both stakes exactly once and records the release', async () => {
    mockPrisma.$transaction.mockImplementation(async (fn) => fn(mockPrisma));

    const result = await releaseMatch('outbox-1');

    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(lockWalletsInOrder).toHaveBeenCalledWith(mockPrisma, 'player-a', 'player-b');
    // Both players get a CREDIT, never a debit
    expect(mockPrisma.wallet.update).toHaveBeenCalledTimes(2);
    expect(mockPrisma.walletTransaction.create).toHaveBeenCalledTimes(2);
    for (const call of mockPrisma.walletTransaction.create.mock.calls) {
      expect(call[0].data.type).toBe('REFUND');
      expect(call[0].data.amountMinorUnits.toString()).toBe('5000');
      expect(call[0].data.relatedMatchId).toBe('match-1');
    }
    expect(mockPrisma.match.update).toHaveBeenCalledWith({
      where: { id: 'match-1' },
      data: expect.objectContaining({ status: 'RELEASED' })
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
    expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
  });

  it('refunds once per claim; a second claim attempt on the released row writes nothing', async () => {
    mockPrisma.$transaction.mockImplementation(async (fn) => fn(mockPrisma));
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([pendingRow])
      .mockResolvedValueOnce([]);

    await releaseMatch('outbox-1');
    await releaseMatch('outbox-1');

    // Only the first claim produced refunds; no extra debit or credit tuples
    expect(mockPrisma.walletTransaction.create).toHaveBeenCalledTimes(2);
    expect(mockPrisma.wallet.update).toHaveBeenCalledTimes(2);
  });
});

describe('gameActivationService limits', () => {
  it('exposes the attempt budget used to decide release vs retry', () => {
    expect(MAX_ACTIVATION_ATTEMPTS).toBeGreaterThan(0);
  });
});