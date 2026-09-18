import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockPrisma = {
  outboxEvent: {
    findMany: jest.fn(),
    updateMany: jest.fn()
  }
};

jest.unstable_mockModule('../../utils/db.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));
jest.unstable_mockModule('../../services/outboxService.js', () => ({
  OUTBOX_LEASE_MS: 30_000,
  OUTBOX_MAX_ATTEMPTS: 5,
  OUTBOX_BATCH_SIZE: 50
}));

const emitMock = jest.fn();
const toMock = jest.fn().mockReturnValue({ emit: emitMock });
const fetchSocketsMock = jest.fn();
const inMock = jest.fn().mockReturnValue({ fetchSockets: fetchSocketsMock });
jest.unstable_mockModule('../../sockets/index.js', () => ({
  getIO: jest.fn(() => ({ to: toMock, in: inMock }))
}));

const { processOutboxDrainer, deliverEvent } = await import('../outboxDrainer.js');

const event = (overrides = {}) => ({
  id: 'ob-1',
  aggregateType: 'Wallet',
  aggregateId: 'wallet-1',
  eventType: 'wallet.updated',
  attempts: 0,
  claimToken: null,
  claimExpiresAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  payload: {
    userId: 'user-1',
    walletId: 'wallet-1',
    currency: 'NGN',
    type: 'PAYOUT',
    balanceChange: '180000',
    amountMinorUnits: '180000',
    matchId: 'm1'
  },
  ...overrides
});

const notification = (overrides = {}) =>
  event({
    aggregateType: 'Notification',
    aggregateId: 'notif-1',
    eventType: 'notification',
    payload: {
      notificationId: 'notif-1',
      userId: 'user-1',
      type: 'DEPOSIT_CONFIRMED',
      title: 'Deposit Complete',
      message: 'Added',
      link: '/wallet',
      matchId: null,
      createdAt: '2026-01-01T00:00:00.000Z'
    },
    ...overrides
  });

const fixedStart = new Date('2026-01-02T00:00:00Z');

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
});

describe('processOutboxDrainer', () => {
  it('claims lease-free events, delivers and settles them SENT via claim-token CAS', async () => {
    mockPrisma.outboxEvent.findMany.mockResolvedValue([event()]);

    const result = await processOutboxDrainer({ clock: () => fixedStart });

    // liveness claim with lease token + expiry
    const claimCall = mockPrisma.outboxEvent.updateMany.mock.calls.find(
      ([args]) => args.data.claimToken !== undefined
    );
    expect(claimCall[0].where).toEqual({
      id: 'ob-1',
      status: 'PENDING',
      OR: [{ claimExpiresAt: null }, { claimExpiresAt: { lt: fixedStart } }]
    });
    expect(claimCall[0].data.claimExpiresAt.getTime()).toBe(fixedStart.getTime() + 30_000);
    // delivery + SENT settle
    expect(emitMock).toHaveBeenCalledWith('wallet_updated', {
      balanceChange: '180000',
      type: 'PAYOUT',
      matchId: 'm1'
    });
    expect(toMock).toHaveBeenCalledWith('user:user-1');
    const settleCall = mockPrisma.outboxEvent.updateMany.mock.calls.find(
      ([args]) => args.data.status === 'SENT'
    );
    expect(settleCall[0].where).toEqual({ id: 'ob-1', claimToken: expect.any(String) });
    expect(result).toMatchObject({ scanned: 1, claimed: 1, delivered: 1, backoff: 0, failed: 0 });
  });

  it('never marks SENT a row it did not win the claim on (CAS count 0)', async () => {
    mockPrisma.outboxEvent.findMany.mockResolvedValue([event()]);
    mockPrisma.outboxEvent.updateMany.mockResolvedValue({ count: 0 });

    const result = await processOutboxDrainer({ clock: () => fixedStart });

    expect(result).toMatchObject({ scanned: 1, claimed: 0, delivered: 0 });
    expect(emitMock).not.toHaveBeenCalled();
    expect(mockPrisma.outboxEvent.updateMany).toHaveBeenCalledTimes(1);
  });

  it('backs off a failed delivery: increments attempts, clears the lease, stays PENDING', async () => {
    mockPrisma.outboxEvent.findMany.mockResolvedValue([event()]);
    const deliver = jest.fn().mockRejectedValue(new Error('socket burst'));
    mockPrisma.outboxEvent.updateMany.mockImplementation(async ({ data }) =>
      data.status === 'SENT' ? { count: 1 } : { count: 1 }
    );

    const result = await processOutboxDrainer({ clock: () => fixedStart, deliver });

    const backoffCall = mockPrisma.outboxEvent.updateMany.mock.calls.find(
      ([args]) => args.data.attempts === 1 && args.data.status === undefined
    );
    expect(backoffCall[0].where).toEqual({ id: 'ob-1', claimToken: expect.any(String) });
    expect(backoffCall[0].data).toEqual({
      claimToken: null,
      claimExpiresAt: null,
      attempts: 1,
      lastError: 'socket burst'
    });
    expect(result).toMatchObject({ claimed: 1, delivered: 0, backoff: 1, failed: 0 });
  });

  it('parks an event FAILED once attempts reach maxAttempts', async () => {
    mockPrisma.outboxEvent.findMany.mockResolvedValue([event({ attempts: 4 })]);
    const deliver = jest.fn().mockRejectedValue(new Error('provider down'));

    const result = await processOutboxDrainer({
      clock: () => fixedStart,
      maxAttempts: 5,
      deliver
    });

    const failCall = mockPrisma.outboxEvent.updateMany.mock.calls.find(
      ([args]) => args.data.status === 'FAILED'
    );
    expect(failCall[0].data).toMatchObject({ attempts: 5, lastError: 'provider down' });
    expect(result).toMatchObject({ claimed: 1, delivered: 0, backoff: 0, failed: 1 });
  });

  it('reclaims a crashed lease after claimExpiresAt passes', async () => {
    const crashed = event({
      claimToken: 'stale-token',
      claimExpiresAt: new Date('2026-01-01T00:00:00Z')
    });
    mockPrisma.outboxEvent.findMany.mockResolvedValue([crashed]);
    const deliver = jest.fn();

    await processOutboxDrainer({ clock: () => fixedStart, deliver });

    expect(deliver).toHaveBeenCalledTimes(1);
    const claimCall = mockPrisma.outboxEvent.updateMany.mock.calls.find(
      ([args]) => args.data.claimToken !== undefined
    );
    // re-claim uses a NEW token, never the stale one
    expect(claimCall[0].data.claimToken).not.toBe('stale-token');
  });

  it('does not claim an event whose lease is still live', async () => {
    const leased = event({
      claimToken: 'live',
      claimExpiresAt: new Date('2026-01-03T00:00:00Z')
    });
    mockPrisma.outboxEvent.findMany.mockResolvedValue([leased]);

    const result = await processOutboxDrainer({ clock: () => fixedStart });

    expect(result).toMatchObject({ scanned: 1, claimed: 0 });
    expect(mockPrisma.outboxEvent.updateMany).not.toHaveBeenCalled();
  });
});

describe('deliverEvent', () => {
  it('pushes wallet_updated with the signed balanceChange to the user room', async () => {
    await deliverEvent(event());
    expect(toMock).toHaveBeenCalledWith('user:user-1');
    expect(emitMock).toHaveBeenCalledWith('wallet_updated', {
      balanceChange: '180000',
      type: 'PAYOUT',
      matchId: 'm1'
    });
  });

  it('pushes notification live and falls back to FCM when the user has no sockets', async () => {
    fetchSocketsMock.mockResolvedValue([]);
    await deliverEvent(notification());

    expect(inMock).toHaveBeenCalledWith('user:user-1');
    expect(fetchSocketsMock).toHaveBeenCalled();
    expect(emitMock).toHaveBeenCalledWith('notification', expect.objectContaining({
      id: 'notif-1',
      userId: 'user-1',
      type: 'DEPOSIT_CONFIRMED'
    }));
  });

  it('skips the FCM fallback when the user is online', async () => {
    fetchSocketsMock.mockResolvedValue([{ id: 'sock-1' }]);
    await deliverEvent(notification());
    expect(emitMock).toHaveBeenCalledWith('notification', expect.objectContaining({ id: 'notif-1' }));
  });

  it('throws on an unknown eventType so the row is parked, not spun', async () => {
    await expect(deliverEvent(event({ eventType: 'mystery' }))).rejects.toThrow(/unknown eventType/);
  });
});