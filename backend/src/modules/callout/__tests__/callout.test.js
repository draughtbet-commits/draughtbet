import { jest } from '@jest/globals';

const mockTx = {
  $queryRaw: jest.fn(),
  $executeRaw: jest.fn(),
  user: { findUnique: jest.fn() },
  match: { findFirst: jest.fn() }
};

const mockPrisma = {
  $transaction: jest.fn(),
  ...mockTx,
  gameOutbox: { findUnique: jest.fn() }
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

const mockCreateMatchWithStakes = jest.fn();
class FakeActiveMatchError extends Error {
  constructor(message = 'Player already has an active match') {
    super(message);
    this.name = 'ActiveMatchError';
  }
}

jest.unstable_mockModule('../../../services/matchService.js', () => ({
  createMatchWithStakes: mockCreateMatchWithStakes,
  ActiveMatchError: FakeActiveMatchError
}));

const mockInitializeGame = jest.fn();
const mockFinalizeMatchActivation = jest.fn();
jest.unstable_mockModule('../../../sockets/gameManager.js', () => ({
  initializeGame: mockInitializeGame
}));
jest.unstable_mockModule('../../../services/gameActivationService.js', () => ({
  finalizeMatchActivation: mockFinalizeMatchActivation
}));

const mockEmit = jest.fn();
const mockTo = jest.fn().mockReturnValue({ emit: mockEmit });
jest.unstable_mockModule('../../../sockets/index.js', () => ({
  getIO: jest.fn(() => ({
    emit: mockEmit,
    to: mockTo
  }))
}));

const mockNotificationCreate = jest.fn();
jest.unstable_mockModule('../../notification/service.js', () => ({
  NotificationService: { create: mockNotificationCreate }
}));

const calloutFixture = {
  id: 'callout-1',
  challengerId: 'player-1',
  acceptedBy: null,
  tier: 'PRO',
  stakeMinorUnits: '1000000',
  status: 'OPEN',
  expiresAt: new Date(Date.now() + 60 * 60 * 1000)
};

const matchService = await import('../../../services/matchService.js');
const { acceptCallout } = await import('../service.js');

class FakeInsufficientFundsError extends Error {
  constructor() {
    super('Insufficient funds');
    this.name = 'InsufficientFundsError';
  }
}

const challengerOk = { id: 'player-1', tier: 'PRO', isBanned: false };
const acceptorOk = { id: 'player-2', tier: 'PRO', isBanned: false };

describe('acceptCallout policy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(async (fn) => fn(mockPrisma));
    mockTx.$queryRaw.mockReset();
    mockTx.$queryRaw.mockResolvedValue([calloutFixture]);
    mockTx.user.findUnique.mockReset();
    mockTx.user.findUnique
      .mockResolvedValueOnce(challengerOk)
      .mockResolvedValueOnce(acceptorOk);
    mockTx.match.findFirst.mockReset();
    mockTx.match.findFirst.mockResolvedValue(null);
  });

  const expectNoSideEffects = () => {
    expect(mockCreateMatchWithStakes).not.toHaveBeenCalled();
    expect(mockTx.$executeRaw).not.toHaveBeenCalled();
    expect(mockFinalizeMatchActivation).not.toHaveBeenCalled();
  };

  it('claims, validates and funds atomically, then notifies both rooms', async () => {
    mockCreateMatchWithStakes.mockResolvedValue({
      id: 'match-1',
      stakeMinorUnits: 1000000n
    });
    mockPrisma.gameOutbox.findUnique.mockResolvedValue({ id: 'outbox-1' });
    mockFinalizeMatchActivation.mockResolvedValue('ACTIVATED');

    const payload = await acceptCallout('player-2', 'callout-1');

    expect(mockTx.$queryRaw).toHaveBeenCalled();
    expect(mockCreateMatchWithStakes).toHaveBeenCalledWith(
      mockPrisma,
      'player-1',
      'player-2',
      '1000000',
      'PRO'
    );
    expect(mockTx.$executeRaw).toHaveBeenCalled();
    expect(mockPrisma.gameOutbox.findUnique).toHaveBeenCalledWith({
      where: { matchId: 'match-1' },
      select: { id: true }
    });
    expect(mockFinalizeMatchActivation).toHaveBeenCalledWith('outbox-1');
    expect(mockInitializeGame).not.toHaveBeenCalled();
    expect(mockTo).toHaveBeenCalledWith('user:player-1');
    expect(mockTo).toHaveBeenCalledWith('user:player-2');
    expect(mockEmit).toHaveBeenCalledWith('match_found', expect.anything());
    expect(mockNotificationCreate).toHaveBeenCalledWith(
      'player-1', 'CALLOUT_ACCEPTED', expect.anything(), expect.anything(), '/match/match-1', 'match-1'
    );
    expect(payload).toEqual({ id: 'match-1', stakeMinorUnits: '1000000' });
  });

  it('still notifies players when activation fails (the sweep repairs it)', async () => {
    mockCreateMatchWithStakes.mockResolvedValue({
      id: 'match-1',
      stakeMinorUnits: 1000000n
    });
    mockPrisma.gameOutbox.findUnique.mockResolvedValue({ id: 'outbox-1' });
    mockFinalizeMatchActivation.mockRejectedValue(new Error('redis down'));

    await expect(acceptCallout('player-2', 'callout-1')).resolves.toEqual({
      id: 'match-1',
      stakeMinorUnits: '1000000'
    });

    expect(mockFinalizeMatchActivation).toHaveBeenCalledWith('outbox-1');
    expect(mockEmit).toHaveBeenCalledWith('match_found', expect.anything());
  });

  it('does not emit match_found when funding itself fails', async () => {
    mockCreateMatchWithStakes.mockRejectedValue(new FakeInsufficientFundsError());
    mockPrisma.gameOutbox.findUnique.mockResolvedValue({ id: 'outbox-1' });

    await expect(acceptCallout('player-2', 'callout-1'))
      .rejects.toThrow('Insufficient funds');

    expect(mockPrisma.gameOutbox.findUnique).not.toHaveBeenCalled();
    expect(mockFinalizeMatchActivation).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('rejects self-accept before any reservation or claim write', async () => {
    await expect(acceptCallout('player-1', 'callout-1'))
      .rejects.toThrow('Cannot accept your own callout');
    expectNoSideEffects();
  });

  it('rejects an already claimed, cancelled or expired callout', async () => {
    mockTx.$queryRaw.mockResolvedValue([{ ...calloutFixture, status: 'ACCEPTED' }]);
    await expect(acceptCallout('player-2', 'callout-1'))
      .rejects.toThrow('Callout is no longer available');
    expectNoSideEffects();
  });

  it('rejects when the challenger is banned', async () => {
    mockTx.user.findUnique
      .mockReset()
      .mockResolvedValueOnce({ id: 'player-1', tier: 'PRO', isBanned: true })
      .mockResolvedValueOnce(acceptorOk);
    await expect(acceptCallout('player-2', 'callout-1'))
      .rejects.toThrow('Challenger is not eligible to play');
    expectNoSideEffects();
  });

  it('rejects when the acceptor is banned', async () => {
    mockTx.user.findUnique
      .mockReset()
      .mockResolvedValueOnce(challengerOk)
      .mockResolvedValueOnce({ id: 'player-2', tier: 'PRO', isBanned: true });
    await expect(acceptCallout('player-2', 'callout-1'))
      .rejects.toThrow('Acceptor is not eligible to play');
    expectNoSideEffects();
  });

  it('rejects a cross-tier accept', async () => {
    mockTx.user.findUnique
      .mockReset()
      .mockResolvedValueOnce(challengerOk)
      .mockResolvedValueOnce({ id: 'player-2', tier: 'AMATEUR', isBanned: false });
    await expect(acceptCallout('player-2', 'callout-1'))
      .rejects.toThrow('Acceptor tier does not match the callout tier');
    expectNoSideEffects();
  });

  it('rejects when either player already has an active match', async () => {
    mockTx.match.findFirst.mockResolvedValue({ id: 'match-active' });
    await expect(acceptCallout('player-2', 'callout-1'))
      .rejects.toThrow('Player already has an active match');
    expectNoSideEffects();
  });

  it('propagates insufficient funds and leaves the callout unclaimed', async () => {
    mockCreateMatchWithStakes.mockRejectedValue(new FakeInsufficientFundsError());

    await expect(acceptCallout('player-2', 'callout-1'))
      .rejects.toThrow('Insufficient funds');

    // The ACCEPTED write never ran, so the row lock release leaves it OPEN.
    expect(mockTx.$executeRaw).not.toHaveBeenCalled();
    expect(mockFinalizeMatchActivation).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });
});