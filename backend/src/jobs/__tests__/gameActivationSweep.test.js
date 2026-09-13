import { jest } from '@jest/globals';

const mockPrisma = {
  gameOutbox: { findMany: jest.fn() }
};

jest.unstable_mockModule('../../utils/db.js', () => ({
  default: mockPrisma
}));

const mockFinalize = jest.fn();
const mockRelease = jest.fn();
jest.unstable_mockModule('../../services/gameActivationService.js', () => ({
  finalizeMatchActivation: mockFinalize,
  releaseMatch: mockRelease,
  MAX_ACTIVATION_ATTEMPTS: 5
}));

const logger = (await import('../../utils/logger.js')).default;
jest.spyOn(logger, 'error').mockImplementation(() => {});
jest.spyOn(logger, 'info').mockImplementation(() => {});

const { processGameActivationSweep } = await import('../gameActivationSweep.js');

const row = (overrides) => ({
  id: 'outbox-1',
  matchId: 'match-1',
  attempts: 1,
  ...overrides
});

describe('processGameActivationSweep', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('only looks at unreleased records whose claim lease is free', async () => {
    mockPrisma.gameOutbox.findMany.mockResolvedValue([]);
    await processGameActivationSweep();

    expect(mockPrisma.gameOutbox.findMany).toHaveBeenCalledWith({
      where: {
        status: { in: ['PENDING', 'ACTIVATING'] },
        OR: [{ claimExpiresAt: null }, { claimExpiresAt: { lt: expect.any(Date) } }]
      },
      orderBy: { createdAt: 'asc' },
      take: 50
    });
  });

  it('replays a pending record by finalizing it', async () => {
    mockPrisma.gameOutbox.findMany.mockResolvedValue([row({ attempts: 2 })]);
    mockFinalize.mockResolvedValue('ACTIVATED');

    await processGameActivationSweep();

    expect(mockFinalize).toHaveBeenCalledWith('outbox-1');
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it('releases a record that exhausted its attempt budget', async () => {
    mockPrisma.gameOutbox.findMany.mockResolvedValue([row({ attempts: 5 })]);
    mockRelease.mockResolvedValue({ released: true });

    await processGameActivationSweep();

    expect(mockRelease).toHaveBeenCalledWith('outbox-1');
    expect(mockFinalize).not.toHaveBeenCalled();
  });

  it('keeps sweeping when one record fails and logs the error', async () => {
    mockPrisma.gameOutbox.findMany.mockResolvedValue([
      row({ id: 'o1', attempts: 1 }),
      row({ id: 'o2', attempts: 1 })
    ]);
    mockFinalize.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('ACTIVATED');

    await processGameActivationSweep();

    expect(mockFinalize).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalled();
  });
});