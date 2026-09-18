import { jest } from '@jest/globals';

jest.unstable_mockModule('../../../utils/db.js', () => ({ default: mockDb }));
jest.unstable_mockModule('../../audit/service.js', () => ({
  recordAdminAction: jest.fn().mockResolvedValue(undefined)
}));

const mockDb = {
  adminRole: {
    upsert: jest.fn(),
    findUnique: jest.fn(),
    findUniqueOrThrow: jest.fn()
  },
  adminRoleAssignment: {
    findMany: jest.fn(),
    upsert: jest.fn(),
    deleteMany: jest.fn()
  }
};

const {
  ensureRoles,
  getUserRoles,
  getRoleNames,
  hasPermission,
  assignRole,
  revokeRole,
  requirePermission,
  requireAdminMfa,
  PermissionDeniedError,
  RoleAssignmentError
} = await import('../service.js');
const { roleHasPermission, PERMISSIONS, ADMIN_ROLES } = await import('../permissions.js');
const { recordAdminAction } = await import('../../audit/service.js');

const ALL = Object.values(PERMISSIONS);

const MATRIX = {
  SUPER_ADMIN: ALL,
  FINANCE: ['withdrawals.read', 'withdrawals.process', 'ledger.adjust', 'audit.read'],
  RISK_COMPLIANCE: ['verification.review', 'risk.review', 'safer-play.lift', 'audit.read'],
  SUPPORT: ['users.manage', 'disputes.manage', 'safer-play.lift', 'audit.read'],
  GAME_OPERATIONS: ['audit.read'],
  READ_ONLY_AUDITOR: ['withdrawals.read', 'audit.read']
};

describe('rbac matrix', () => {
  it('grants every role exactly its declared permissions', () => {
    for (const role of Object.keys(MATRIX)) {
      for (const permission of MATRIX[role]) {
        expect(`${role} grants ${permission}`).toBeTruthy();
        expect(roleHasPermission(role, permission)).toBe(true);
      }
      for (const permission of ALL) {
        if (!MATRIX[role].includes(permission)) {
          expect(roleHasPermission(role, permission)).toBe(false);
        }
      }
    }
  });

  it('keeps role grants exclusive to SUPER_ADMIN', () => {
    for (const role of Object.keys(MATRIX)) {
      if (role === 'SUPER_ADMIN') continue;
      expect(roleHasPermission(role, 'roles.admin')).toBe(false);
    }
  });

  it('leaves USER read/write and financial control to the intended roles', () => {
    expect(roleHasPermission('SUPPORT', 'users.manage')).toBe(true);
    expect(roleHasPermission('FINANCE', 'users.manage')).toBe(false);
    expect(roleHasPermission('FINANCE', 'withdrawals.process')).toBe(true);
    expect(roleHasPermission('RISK_COMPLIANCE', 'withdrawals.process')).toBe(false);
    expect(roleHasPermission('RISK_COMPLIANCE', 'verification.review')).toBe(true);
    expect(roleHasPermission('SUPPORT', 'verification.review')).toBe(false);
    expect(roleHasPermission('SUPPORT', 'disputes.manage')).toBe(true);
    expect(roleHasPermission('GAME_OPERATIONS', 'ledger.adjust')).toBe(false);
    expect(roleHasPermission('READ_ONLY_AUDITOR', 'withdrawals.process')).toBe(false);
  });
});

describe('rbac role administration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('seeds the six roles idempotently', async () => {
    mockDb.adminRole.upsert.mockResolvedValue({ id: 'r', name: 'x' });
    const seeded = await ensureRoles({ dbp: mockDb });
    expect(seeded).toEqual(ADMIN_ROLES);
    expect(mockDb.adminRole.upsert).toHaveBeenCalledTimes(6);
    expect(mockDb.adminRole.upsert).toHaveBeenCalledWith({
      where: { name: 'FINANCE' },
      create: expect.objectContaining({ name: 'FINANCE' }),
      update: { description: expect.any(String) }
    });
  });

  it('refuses to assign an unknown role', async () => {
    await expect(
      assignRole('u1', 'OVERLORD', { dbp: mockDb })
    ).rejects.toThrow(RoleAssignmentError);
    expect(mockDb.adminRole.upsert).not.toHaveBeenCalled();
  });

  it('assigns a role via a compound unique upsert carrying the actor', async () => {
    mockDb.adminRole.upsert.mockResolvedValue({ id: 'r-finance', name: 'FINANCE' });
    mockDb.adminRole.findUniqueOrThrow.mockResolvedValue({ id: 'r-finance', name: 'FINANCE' });
    mockDb.adminRoleAssignment.upsert.mockResolvedValue({ id: 'asn-1' });

    await assignRole('u1', 'FINANCE', { assignedBy: 'admin-9', dbp: mockDb });

    expect(mockDb.adminRole.findUniqueOrThrow).toHaveBeenCalledWith({ where: { name: 'FINANCE' } });
    expect(mockDb.adminRoleAssignment.upsert).toHaveBeenCalledWith({
      where: { userId_roleId: { userId: 'u1', roleId: 'r-finance' } },
      create: { userId: 'u1', roleId: 'r-finance', assignedBy: 'admin-9' },
      update: expect.objectContaining({ assignedBy: 'admin-9' })
    });
  });

  it('revokes a role and is a no-op for a role that does not exist', async () => {
    mockDb.adminRole.findUnique.mockResolvedValueOnce({ id: 'r-support', name: 'SUPPORT' });
    mockDb.adminRoleAssignment.deleteMany.mockResolvedValue({ count: 1 });
    await revokeRole('u1', 'SUPPORT', { dbp: mockDb });
    expect(mockDb.adminRoleAssignment.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u1', roleId: 'r-support' }
    });

    jest.clearAllMocks();
    mockDb.adminRole.findUnique.mockResolvedValueOnce(null);
    expect(await revokeRole('u1', 'GHOST', { dbp: mockDb })).toBeNull();
    expect(mockDb.adminRoleAssignment.deleteMany).not.toHaveBeenCalled();
  });
});

describe('rbac permission resolution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves hasPermission from fresh DB assignments', async () => {
    mockDb.adminRoleAssignment.findMany.mockResolvedValueOnce([{ role: { name: 'SUPPORT' } }]);
    expect(await hasPermission('u1', 'users.manage', { dbp: mockDb })).toBe(true);

    mockDb.adminRoleAssignment.findMany.mockResolvedValueOnce([{ role: { name: 'SUPPORT' } }]);
    expect(await hasPermission('u1', 'ledger.adjust', { dbp: mockDb })).toBe(false);
  });

  it('returns role names in assignment order', async () => {
    mockDb.adminRoleAssignment.findMany.mockResolvedValue([
      { role: { name: 'SUPPORT' } },
      { role: { name: 'READ_ONLY_AUDITOR' } }
    ]);
    expect(await getRoleNames('u1', { dbp: mockDb })).toEqual(['SUPPORT', 'READ_ONLY_AUDITOR']);
  });
});

describe('rbac requirePermission', () => {
  const make = () => {
    const req = { user: { id: 'admin-1' }, ip: '1.2.3.4', id: 'req-1', method: 'GET', originalUrl: '/admin/x', get: () => 'agent' };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    return { req, res, next };
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lets a granted caller through and exposes their roles', async () => {
    const { req, res, next } = make();
    mockDb.adminRoleAssignment.findMany.mockResolvedValue([{ role: { name: 'SUPPORT' } }]);

    await requirePermission('disputes.manage')(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.adminRoles).toEqual(['SUPPORT']);
    expect(res.status).not.toHaveBeenCalled();
    expect(recordAdminAction).not.toHaveBeenCalled();
  });

  it('denies a caller without the permission and audits DENIED', async () => {
    const { req, res, next } = make();
    mockDb.adminRoleAssignment.findMany.mockResolvedValue([{ role: { name: 'SUPPORT' } }]);

    await requirePermission('ledger.adjust')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Insufficient admin permission' });
    expect(next).not.toHaveBeenCalled();
    expect(recordAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        adminId: 'admin-1',
        action: 'permission.denied:ledger.adjust',
        outcome: 'DENIED',
        targetType: 'admin',
        targetId: 'admin-1',
        ip: '1.2.3.4',
        requestId: 'req-1'
      })
    );
  });

  it('forwards database errors to the error middleware', async () => {
    const { req, res, next } = make();
    mockDb.adminRoleAssignment.findMany.mockRejectedValue(new Error('db down'));
    await requirePermission('audit.read')(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe('rbac requireAdminMfa', () => {
  const make = () => {
    const req = { user: { id: 'admin-1' }, ip: '1.2.3.4', id: 'req-1', method: 'GET', originalUrl: '/admin/x', get: () => undefined };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    return { req, res, next };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ADMIN_MFA_ENFORCED;
    delete process.env.ADMIN_MFA_CODE;
  });

  it('passes through when MFA is not enforced', () => {
    const { req, res, next } = make();
    requireAdminMfa(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(recordAdminAction).not.toHaveBeenCalled();
  });

  it('denies a missing code when MFA is enforced and audits DENIED', () => {
    process.env.ADMIN_MFA_ENFORCED = 'true';
    process.env.ADMIN_MFA_CODE = '123456';
    const { req, res, next } = make();
    requireAdminMfa(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Admin MFA code required' });
    expect(next).not.toHaveBeenCalled();
    expect(recordAdminAction).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'DENIED' }));
  });

  it('accepts the code and audits SUCCESS', () => {
    process.env.ADMIN_MFA_ENFORCED = 'true';
    process.env.ADMIN_MFA_CODE = '123456';
    const { req, res, next } = make();
    req.get = (h) => (h === 'x-admin-mfa-code' ? '123456' : undefined);
    requireAdminMfa(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(recordAdminAction).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'SUCCESS' }));
  });
});