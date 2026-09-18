import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

const { enqueueEvent, enqueueNotificationDelivery, enqueueWalletUpdated } =
  await import('../../services/outboxService.js');

const tx = {
  outboxEvent: { create: jest.fn(), findUnique: jest.fn() }
};

beforeEach(() => {
  jest.clearAllMocks();
  tx.outboxEvent.create.mockImplementation(async ({ data }) => ({ id: 'ob-1', ...data }));
  tx.outboxEvent.findUnique.mockResolvedValue(null);
});

describe('outboxService enqueue helpers', () => {
  it('enqueues a plain event', async () => {
    await enqueueEvent(tx, {
      aggregateType: 'Wallet',
      aggregateId: 'wallet-1',
      eventType: 'wallet.updated',
      payload: { balanceChange: '100' }
    });
    expect(tx.outboxEvent.create).toHaveBeenCalledWith({
      data: {
        aggregateType: 'Wallet',
        aggregateId: 'wallet-1',
        eventType: 'wallet.updated',
        dedupeKey: null,
        payload: { balanceChange: '100' }
      }
    });
  });

  it('short-circuits a replay via check-first (never re-inserts the same dedupeKey)', async () => {
    tx.outboxEvent.findUnique.mockResolvedValue({ id: 'ob-1' });
    const done = await enqueueEvent(tx, {
      aggregateType: 'Wallet', aggregateId: 'w', eventType: 'wallet.updated', payload: {}, dedupeKey: 'dup'
    });
    expect(done).toBeNull();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('swallows a P2002 replay when a dedupeKey is set but rethrows otherwise', async () => {
    tx.outboxEvent.findUnique.mockResolvedValue(null);
    tx.outboxEvent.create.mockRejectedValue({ code: 'P2002' });
    const done = await enqueueEvent(tx, {
      aggregateType: 'Wallet', aggregateId: 'w', eventType: 'wallet.updated', payload: {}, dedupeKey: 'dup'
    });
    expect(done).toBeNull();

    await expect(
      enqueueEvent(tx, { aggregateType: 'Wallet', aggregateId: 'w', eventType: 'wallet.updated', payload: {} })
    ).rejects.toEqual({ code: 'P2002' });
  });

  it('requires a dedupeKey for notification delivery', async () => {
    await expect(
      enqueueNotificationDelivery(tx, { id: 'n1', userId: 'u1' }, {})
    ).rejects.toThrow('enqueueNotificationDelivery requires a dedupeKey');
  });

  it('builds the delivery payload from the notification row', async () => {
    await enqueueNotificationDelivery(
      tx,
      {
        id: 'n1',
        userId: 'u1',
        type: 'DEPOSIT_CONFIRMED',
        title: 'T',
        message: 'M',
        link: '/wallet',
        matchId: null,
        createdAt: new Date('2026-01-01T00:00:00Z')
      },
      { dedupeKey: 'notify:deposit:i1' }
    );
    expect(tx.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        aggregateType: 'Notification',
        aggregateId: 'n1',
        eventType: 'notification',
        dedupeKey: 'notify:deposit:i1',
        payload: {
          notificationId: 'n1',
          userId: 'u1',
          type: 'DEPOSIT_CONFIRMED',
          title: 'T',
          message: 'M',
          link: '/wallet',
          matchId: null,
          createdAt: '2026-01-01T00:00:00.000Z'
        }
      })
    });
  });

  it('builds the wallet.updated payload with the signed balanceChange', async () => {
    await enqueueWalletUpdated(tx, {
      userId: 'u1',
      walletId: 'w1',
      currency: 'NGN',
      type: 'PAYOUT',
      amountMinorUnits: 180000n,
      matchId: 'm1',
      dedupeKey: 'wallet:settle:m1:u1'
    });
    expect(tx.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        aggregateType: 'Wallet',
        aggregateId: 'w1',
        eventType: 'wallet.updated',
        dedupeKey: 'wallet:settle:m1:u1',
        payload: {
          userId: 'u1',
          walletId: 'w1',
          currency: 'NGN',
          type: 'PAYOUT',
          balanceChange: '180000',
          amountMinorUnits: '180000',
          matchId: 'm1'
        }
      })
    });
  });
});