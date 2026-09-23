import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockPrisma = {
  withdrawal: {
    findMany: jest.fn()
  }
};

jest.unstable_mockModule('../../utils/db.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

const { processProviderFollowUp, resolveFollowUpThreshold } = await import('../providerFollowUp.js');

const stuck = (overrides = {}) => ({
  id: 'wd-1',
  userId: 'user-1',
  gateway: 'PAYSTACK',
  reference: 'wit-1',
  providerRef: 'prov-ref-1',
  status: 'PROCESSING',
  processedAt: new Date('2026-01-01T00:00:00Z'),
  followUpCheckAt: null,
  ...overrides
});

const now = new Date('2026-01-02T00:00:00Z');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('processProviderFollowUp', () => {
  it('queries only PROCESSING rows past the age threshold that are due a re-check', async () => {
    mockPrisma.withdrawal.findMany.mockResolvedValue([]);

    await processProviderFollowUp({ service: {}, now, maxPerRun: 7, ageHours: 6 });

    const { where, orderBy, take } = mockPrisma.withdrawal.findMany.mock.calls[0][0];
    expect(where.status).toBe('PROCESSING');
    expect(where.processedAt.lt).toEqual(resolveFollowUpThreshold(now, 6));
    expect(where.OR).toEqual([{ followUpCheckAt: null }, expect.any(Object)]);
    expect(orderBy).toEqual({ processedAt: 'asc' });
    expect(take).toBe(7);
  });

  it('resolves via reportPayoutResult on a provider success verdict', async () => {
    mockPrisma.withdrawal.findMany.mockResolvedValue([stuck()]);
    const service = {
      providers: { PAYSTACK: { verifyPayoutStatus: jest.fn().mockResolvedValue({ status: 'success' }) } },
      reportPayoutResult: jest.fn().mockResolvedValue({}),
      noteFollowUpCheck: jest.fn()
    };

    const result = await processProviderFollowUp({ service, now });

    expect(service.providers.PAYSTACK.verifyPayoutStatus).toHaveBeenCalledWith({
      reference: 'wit-1',
      providerRef: 'prov-ref-1'
    });
    expect(service.reportPayoutResult).toHaveBeenCalledWith('wd-1', { success: true });
    expect(service.noteFollowUpCheck).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scanned: 1, checked: 1, resolved: 1, pending: 0, errored: 0 });
  });

  it('resolves with a failure reason when the provider reports a failed transfer', async () => {
    mockPrisma.withdrawal.findMany.mockResolvedValue([stuck()]);
    const service = {
      providers: { PAYSTACK: { verifyPayoutStatus: jest.fn().mockResolvedValue({ status: 'failed' }) } },
      reportPayoutResult: jest.fn().mockResolvedValue({}),
      noteFollowUpCheck: jest.fn()
    };

    const result = await processProviderFollowUp({ service, now });

    expect(service.reportPayoutResult).toHaveBeenCalledWith('wd-1', {
      success: false,
      failureReason: expect.stringMatching(/follow-up sweep/i)
    });
    expect(result).toMatchObject({ scanned: 1, resolved: 1, pending: 0, errored: 0 });
  });

  it('never moves money on an ambiguous verdict: just records the check', async () => {
    mockPrisma.withdrawal.findMany.mockResolvedValue([stuck()]);
    const service = {
      providers: { PAYSTACK: { verifyPayoutStatus: jest.fn().mockResolvedValue({ status: 'processing' }) } },
      reportPayoutResult: jest.fn(),
      noteFollowUpCheck: jest.fn().mockResolvedValue(true)
    };

    const result = await processProviderFollowUp({ service, now });

    expect(service.reportPayoutResult).not.toHaveBeenCalled();
    expect(service.noteFollowUpCheck).toHaveBeenCalledWith('wd-1');
    expect(result).toMatchObject({ scanned: 1, checked: 1, resolved: 0, pending: 1, errored: 0 });
  });

  it('counts an upstream verification failure as errored and moves on', async () => {
    mockPrisma.withdrawal.findMany.mockResolvedValue([
      stuck(),
      stuck({ id: 'wd-2' })
    ]);
    const service = {
      providers: {
        PAYSTACK: {
          verifyPayoutStatus: jest
            .fn()
            .mockRejectedValueOnce(new Error('timeout'))
            .mockResolvedValueOnce({ status: 'processing' })
        }
      },
      reportPayoutResult: jest.fn(),
      noteFollowUpCheck: jest.fn()
    };

    const result = await processProviderFollowUp({ service, now });

    expect(result).toMatchObject({ scanned: 2, errored: 1, pending: 1 });
    expect(service.reportPayoutResult).not.toHaveBeenCalled();
  });

  it('skips withdrawals whose gateway has no configured provider', async () => {
    mockPrisma.withdrawal.findMany.mockResolvedValue([stuck()]);
    const service = { providers: {} };

    const result = await processProviderFollowUp({ service, now });

    expect(result).toMatchObject({ scanned: 1, errored: 1 });
  });
});