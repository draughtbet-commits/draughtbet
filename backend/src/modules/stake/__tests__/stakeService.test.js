import { jest } from '@jest/globals';

const mockPostStakeReservation = jest.fn();
const mockPostStakeRelease = jest.fn();
jest.unstable_mockModule('../../../services/ledgerService.js', () => ({
  postStakeReservation: mockPostStakeReservation,
  postStakeRelease: mockPostStakeRelease
}));

const { reserveStake, reserveBothStakes, releaseStakes } = await import('../service.js');

const makeTx = () => ({
  stakeReservation: {
    findUnique: jest.fn(),
    create: jest.fn(),
    updateMany: jest.fn()
  },
  wallet: { update: jest.fn() },
  walletTransaction: { create: jest.fn() }
});

const wA = { id: 'w-a', userId: 'player-a', currency: 'NGN' };
const wB = { id: 'w-b', userId: 'player-b', currency: 'NGN' };

describe('stake/service reserveStake', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates a RESERVED row when none exists yet', async () => {
    const tx = makeTx();
    tx.stakeReservation.findUnique.mockResolvedValue(null);
    tx.stakeReservation.create.mockResolvedValue({ id: 'sr-1', status: 'RESERVED' });

    const row = await reserveStake(tx, {
      matchId: 'm-1',
      userId: 'player-a',
      amountMinorUnits: 5000n
    });

    expect(tx.stakeReservation.findUnique).toHaveBeenCalledWith({
      where: { matchId_userId: { matchId: 'm-1', userId: 'player-a' } }
    });
    expect(tx.stakeReservation.create).toHaveBeenCalledWith({
      data: { matchId: 'm-1', userId: 'player-a', amountMinorUnits: 5000n, status: 'RESERVED' }
    });
    expect(row).toEqual({ id: 'sr-1', status: 'RESERVED' });
  });

  it('is idempotent per matchId:userId — an existing row is returned untouched', async () => {
    const tx = makeTx();
    const existing = { id: 'sr-1', matchId: 'm-1', userId: 'player-a', status: 'RESERVED' };
    tx.stakeReservation.findUnique.mockResolvedValue(existing);

    const row = await reserveStake(tx, { matchId: 'm-1', userId: 'player-a', amountMinorUnits: 5000n });

    expect(row).toBe(existing);
    expect(tx.stakeReservation.create).not.toHaveBeenCalled();
  });
});

describe('stake/service reserveBothStakes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reserves rows, debits both legacy wallets and mirrors STAKE_LOCK into the ledger', async () => {
    const tx = makeTx();
    tx.stakeReservation.findUnique.mockResolvedValue(null);
    tx.stakeReservation.create.mockImplementation(async ({ data }) => ({ id: `sr:${data.userId}`, ...data }));

    const rows = await reserveBothStakes(tx, {
      matchId: 'm-1',
      participants: [{ userId: 'player-a' }, { userId: 'player-b' }],
      amountMinorUnits: 5000n,
      wallets: [wB, wA]
    });

    expect(rows.map((r) => r.userId).sort()).toEqual(['player-a', 'player-b']);
    expect(tx.wallet.update).toHaveBeenCalledTimes(2);
    expect(tx.walletTransaction.create).toHaveBeenCalledTimes(2);
    // Legacy mirror debits use each player's OWN wallet row regardless of lock order
    expect(tx.wallet.update).toHaveBeenCalledWith({
      where: { id: 'w-a' },
      data: { balanceMinorUnits: { decrement: 5000n } }
    });
    expect(tx.wallet.update).toHaveBeenCalledWith({
      where: { id: 'w-b' },
      data: { balanceMinorUnits: { decrement: 5000n } }
    });
    expect(tx.walletTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'STAKE', amountMinorUnits: -5000n })
    });

    expect(mockPostStakeReservation).toHaveBeenCalledWith(tx, 'm-1', [
      { userId: 'player-a', currency: 'NGN', amountMinorUnits: 5000n },
      { userId: 'player-b', currency: 'NGN', amountMinorUnits: 5000n }
    ]);
  });

  it('refuses to debit a player whose wallet was not locked', async () => {
    const tx = makeTx();
    await expect(
      reserveBothStakes(tx, {
        matchId: 'm-1',
        participants: [{ userId: 'player-a' }, { userId: 'player-b' }],
        amountMinorUnits: 5000n,
        wallets: [wA]
      })
    ).rejects.toThrow('Wallet not locked for userId: player-b');
    expect(tx.wallet.update).not.toHaveBeenCalled();
  });
});

describe('stake/service releaseStakes', () => {
  it('refunds both wallets, releases only RESERVED rows and mirrors STAKE_RELEASE', async () => {
    const tx = makeTx();
    tx.stakeReservation.updateMany.mockResolvedValue({ count: 2 });

    await releaseStakes(tx, {
      matchId: 'm-1',
      participants: [{ userId: 'player-a' }, { userId: 'player-b' }],
      amountMinorUnits: 5000n,
      wallets: [wA, wB]
    });

    expect(tx.wallet.update).toHaveBeenCalledTimes(2);
    expect(tx.wallet.update).toHaveBeenCalledWith({
      where: { id: 'w-a' },
      data: { balanceMinorUnits: { increment: 5000n } }
    });
    expect(tx.walletTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'REFUND', amountMinorUnits: 5000n, status: 'COMPLETED' })
    });
    expect(tx.stakeReservation.updateMany).toHaveBeenCalledWith({
      where: {
        matchId: 'm-1',
        userId: { in: ['player-a', 'player-b'] },
        status: 'RESERVED'
      },
      data: { status: 'RELEASED' }
    });
    expect(mockPostStakeRelease).toHaveBeenCalledWith(tx, 'm-1', [
      { userId: 'player-a', currency: 'NGN', amountMinorUnits: 5000n },
      { userId: 'player-b', currency: 'NGN', amountMinorUnits: 5000n }
    ]);
  });
});