import { jest } from '@jest/globals';

const mockDb = {
  adminAuditLog: {
    create: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn()
  }
};

jest.unstable_mockModule('../../../utils/db.js', () => ({ default: mockDb }));

const { recordAdminAction, listAdminActions, auditPagination, AUDIT_OUTCOMES } =
  await import('../service.js');

describe('audit recordAdminAction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.adminAuditLog.create.mockResolvedValue({ id: 'log-1' });
  });

  it('persists the acting admin with request metadata on every success', async () => {
    await recordAdminAction({
      adminId: 'admin-1',
      action: 'withdrawal.approve',
      targetType: 'withdrawal',
      targetId: 'wd-9',
      metadata: { amount: '5000' },
      ip: '10.0.0.1',
      userAgent: 'curl',
      requestId: 'req-abc',
      dbp: mockDb
    });

    expect(mockDb.adminAuditLog.create).toHaveBeenCalledWith({
      data: {
        adminId: 'admin-1',
        action: 'withdrawal.approve',
        outcome: 'SUCCESS',
        targetType: 'withdrawal',
        targetId: 'wd-9',
        metadata: { amount: '5000' },
        ip: '10.0.0.1',
        userAgent: 'curl',
        requestId: 'req-abc'
      }
    });
  });

  it('defaults sparse fields to null-safe values', async () => {
    await recordAdminAction({ adminId: 'admin-1', action: 'users.ban', dbp: mockDb });
    expect(mockDb.adminAuditLog.create).toHaveBeenCalledWith({
      data: {
        adminId: 'admin-1',
        action: 'users.ban',
        outcome: 'SUCCESS',
        targetType: null,
        targetId: null,
        metadata: null,
        ip: null,
        userAgent: null,
        requestId: null
      }
    });
  });
});

describe('audit listAdminActions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lists rows newest-first with pagination totals', async () => {
    mockDb.adminAuditLog.findMany.mockResolvedValue([{ id: 'l' }]);
    mockDb.adminAuditLog.count.mockResolvedValue(41);

    const result = await listAdminActions({ page: 3, limit: 20, dbp: mockDb });

    expect(mockDb.adminAuditLog.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: { createdAt: 'desc' },
      skip: 40,
      take: 20
    });
    expect(result.totalPages).toBe(3);
    expect(result.page).toBe(3);
  });

  it('filters by admin, action, outcome and target, dropping unknown outcomes', async () => {
    await listAdminActions({
      adminId: 'admin-1',
      action: 'withdrawal.approve',
      outcome: 'NOT_REAL',
      targetId: 'wd-9',
      dbp: mockDb
    });

    expect(mockDb.adminAuditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { adminId: 'admin-1', action: 'withdrawal.approve', targetId: 'wd-9' }
      })
    );
    expect(mockDb.adminAuditLog.findMany.mock.calls[0][0].where.outcome).toBeUndefined();
  });
});

describe('audit auditPagination', () => {
  it('returns null when pagination is invalid', () => {
    expect(auditPagination({ page: 'nope' })).toBeNull();
  });

  it('parses bounded page/limit and whitelists filters', () => {
    const out = auditPagination({ page: '2', limit: '50', adminId: 'a', outcome: 'DENIED' });
    expect(out).toEqual(expect.objectContaining({ page: 2, limit: 50, adminId: 'a', outcome: 'DENIED' }));
  });

  it('rejects unknown outcomes', () => {
    expect(auditPagination({ outcome: 'LOL' }).outcome).toBeUndefined();
  });

  it('declares only the canonical outcomes', () => {
    expect(AUDIT_OUTCOMES).toEqual(['SUCCESS', 'FAILURE', 'DENIED']);
  });
});