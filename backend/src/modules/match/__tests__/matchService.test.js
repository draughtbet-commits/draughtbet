import { jest } from '@jest/globals';

const {
  LIVE_STATUSES,
  PRETTERMINAL_STATUSES,
  ALLOWED_TRANSITIONS,
  InvalidTransitionError,
  isLiveStatus,
  isPreterminalStatus,
  createMatch,
  transitionMatch,
  transitionMatchWhere,
  hasPreterminalMatchForPlayers
} = await import('../service.js');

const makeClient = () => ({
  match: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn()
  }
});

describe('match/service status vocabulary', () => {
  it('treats IN_PLAY and legacy ACTIVE as the live set', () => {
    expect(LIVE_STATUSES).toEqual(expect.arrayContaining(['ACTIVE', 'IN_PLAY']));
    expect(isLiveStatus('IN_PLAY')).toBe(true);
    expect(isLiveStatus('ACTIVE')).toBe(true);
    expect(isLiveStatus('FUNDED')).toBe(false);
  });

  it('covers the whole pre-terminal lifetime for availability', () => {
    expect(PRETTERMINAL_STATUSES).toEqual(
      expect.arrayContaining(['DRAFT', 'OPEN', 'FUNDED', 'READY', 'IN_PLAY', 'ACTIVE'])
    );
    expect(isPreterminalStatus('READY')).toBe(true);
    expect(isPreterminalStatus('SETTLED')).toBe(false);
  });

  it('exposes the allowed transition map', () => {
    expect(ALLOWED_TRANSITIONS.OPEN).toContain('FUNDED');
    expect(ALLOWED_TRANSITIONS.FUNDED).toContain('READY');
    expect(ALLOWED_TRANSITIONS.FUNDED).toContain('RELEASED');
    expect(ALLOWED_TRANSITIONS.READY).toContain('IN_PLAY');
    expect(ALLOWED_TRANSITIONS.READY).toContain('RELEASED');
    expect(ALLOWED_TRANSITIONS.IN_PLAY).not.toContain('RELEASED');
  });
});

describe('match/service createMatch', () => {
  it('creates an OPEN match with both participants and the fee/time snapshots', async () => {
    const client = makeClient();
    client.match.create.mockResolvedValue({ id: 'm-1', status: 'OPEN' });

    const match = await createMatch(client, {
      matchId: 'm-1',
      playerLightId: 'alice',
      playerDarkId: 'bob',
      tier: 'PRO',
      stakeMinorUnits: 5000n,
      commissionPercent: 10,
      timeControlSeconds: 45,
      currency: 'NGN'
    });

    expect(client.match.create).toHaveBeenCalledWith({
      data: {
        id: 'm-1',
        playerLightId: 'alice',
        playerDarkId: 'bob',
        tier: 'PRO',
        stakeMinorUnits: 5000n,
        status: 'OPEN',
        settlementCommissionPercent: 10,
        timeControlSeconds: 45,
        currency: 'NGN',
        participants: {
          create: [
            { userId: 'alice', side: 'LIGHT' },
            { userId: 'bob', side: 'DARK' }
          ]
        }
      }
    });
    expect(match).toEqual({ id: 'm-1', status: 'OPEN' });
  });
});

describe('match/service transitionMatch', () => {
  it('allows an allowed transition and performs the update', async () => {
    const client = makeClient();
    client.match.findUnique.mockResolvedValue({ status: 'OPEN' });
    client.match.update.mockResolvedValue({ id: 'm-1', status: 'FUNDED' });

    const match = await transitionMatch(client, 'm-1', 'FUNDED');

    expect(client.match.findUnique).toHaveBeenCalledWith({
      where: { id: 'm-1' },
      select: { status: true }
    });
    expect(client.match.update).toHaveBeenCalledWith({
      where: { id: 'm-1' },
      data: { status: 'FUNDED' }
    });
    expect(match).toEqual({ id: 'm-1', status: 'FUNDED' });
  });

  it('throws on an illegal transition before touching the row', async () => {
    const client = makeClient();
    client.match.findUnique.mockResolvedValue({ status: 'OPEN' });

    await expect(transitionMatch(client, 'm-1', 'IN_PLAY')).rejects.toBeInstanceOf(
      InvalidTransitionError
    );
    expect(client.match.update).not.toHaveBeenCalled();
  });

  it('refuses to release a match that is already live', async () => {
    const client = makeClient();
    client.match.findUnique.mockResolvedValue({ status: 'IN_PLAY' });

    await expect(transitionMatch(client, 'm-1', 'RELEASED')).rejects.toBeInstanceOf(
      InvalidTransitionError
    );
  });
});

describe('match/service transitionMatchWhere', () => {
  it('performs an idempotent CAS from the allowed from-statuses with extra data', async () => {
    const client = makeClient();
    client.match.updateMany.mockResolvedValue({ count: 1 });

    const count = await transitionMatchWhere(client, 'm-1', ['READY'], 'IN_PLAY', {
      startedAt: new Date('2026-01-01T00:00:00Z')
    });

    expect(client.match.updateMany).toHaveBeenCalledWith({
      where: { id: 'm-1', status: { in: ['READY'] } },
      data: { status: 'IN_PLAY', startedAt: new Date('2026-01-01T00:00:00Z') }
    });
    expect(count).toBe(1);
  });
});

describe('match/service hasPreterminalMatchForPlayers', () => {
  it('scans the pre-terminal set for both players', async () => {
    const client = makeClient();
    client.match.findFirst.mockResolvedValue(null);

    const found = await hasPreterminalMatchForPlayers(client, ['alice', 'bob']);

    expect(client.match.findFirst).toHaveBeenCalledWith({
      where: {
        status: { in: PRETTERMINAL_STATUSES },
        OR: [
          { playerLightId: 'alice' },
          { playerDarkId: 'alice' },
          { playerLightId: 'bob' },
          { playerDarkId: 'bob' }
        ]
      },
      select: { id: true }
    });
    expect(found).toBe(false);
  });

  it('is true when one player already holds a pre-terminal match', async () => {
    const client = makeClient();
    client.match.findFirst.mockResolvedValue({ id: 'm-other' });

    await expect(hasPreterminalMatchForPlayers(client, ['alice', 'bob'])).resolves.toBe(true);
  });
});