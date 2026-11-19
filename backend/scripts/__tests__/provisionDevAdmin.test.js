import { jest, describe, it, expect, beforeEach } from '@jest/globals';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';

const mockPrisma = {
  user: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn()
  },
  adminRole: {
    upsert: jest.fn().mockResolvedValue({ id: 'role-1', name: 'SUPPORT' }),
    findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'role-1', name: 'SUPPORT' })
  },
  adminRoleAssignment: {
    upsert: jest.fn().mockResolvedValue({ id: 'assign-1' }),
    deleteMany: jest.fn().mockResolvedValue({ count: 1 })
  },
  adminAuditLog: {
    create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    deleteMany: jest.fn().mockResolvedValue({ count: 1 })
  },
  userSession: {
    updateMany: jest.fn().mockResolvedValue({ count: 0 })
  }
};

jest.unstable_mockModule('../../src/utils/db.js', () => ({ default: mockPrisma }));

const { provisionDevAdmin, revokeDevAdmin } = await import('../provisionDevAdmin.js');

describe('provisionDevAdmin security guardrails', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('refuses to run in production, staging, test, or unset NODE_ENV', async () => {
    for (const env of ['production', 'staging', 'test', undefined, '']) {
      await expect(
        provisionDevAdmin({
          email: 'ops@draughtbet.local',
          password: 'ValidOperatorPass123',
          role: 'SUPPORT',
          nodeEnv: env,
          dbp: mockPrisma
        })
      ).rejects.toThrow(/NODE_ENV=development/);
    }
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });

  it('refuses to promote an existing non-admin player account', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'usr_player1_uuid',
      email: 'player1@draughtbet.com',
      isAdmin: false
    });

    await expect(
      provisionDevAdmin({
        email: 'player1@draughtbet.com',
        password: 'ValidOperatorPass123',
        role: 'SUPER_ADMIN',
        nodeEnv: 'development',
        dbp: mockPrisma
      })
    ).rejects.toThrow(/existing player account/i);

    expect(mockPrisma.user.update).not.toHaveBeenCalled();
    expect(mockPrisma.adminRoleAssignment.upsert).not.toHaveBeenCalled();
  });

  it('rejects weak or empty passwords and unknown roles', async () => {
    await expect(
      provisionDevAdmin({
        email: 'ops@draughtbet.local',
        password: 'short',
        role: 'SUPPORT',
        nodeEnv: 'development',
        dbp: mockPrisma
      })
    ).rejects.toThrow(/at least 12 characters/i);

    await expect(
      provisionDevAdmin({
        email: 'ops@draughtbet.local',
        password: 'ValidOperatorPass123',
        role: 'GOD_MODE',
        nodeEnv: 'development',
        dbp: mockPrisma
      })
    ).rejects.toThrow(/Invalid role/);
  });

  it('creates dedicated operator, assigns RBAC role, and records audit log in development', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce(null);
    mockPrisma.user.create.mockResolvedValueOnce({
      id: 'dev-op-1',
      email: 'ops@draughtbet.local',
      isAdmin: true
    });

    const result = await provisionDevAdmin({
      email: 'ops@draughtbet.local',
      password: 'ValidOperatorPass123',
      role: 'SUPPORT',
      nodeEnv: 'development',
      dbp: mockPrisma
    });

    expect(result).toEqual({
      userId: 'dev-op-1',
      email: 'ops@draughtbet.local',
      role: 'SUPPORT',
      created: true
    });
    expect(mockPrisma.adminRoleAssignment.upsert).toHaveBeenCalled();
    expect(mockPrisma.adminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          adminId: 'dev-op-1',
          action: 'dev.admin.provisioned',
          outcome: 'SUCCESS'
        })
      })
    );
  });

  it('revokes operator sessions, role assignments, and admin flag safely', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'dev-op-1',
      email: 'ops@draughtbet.local',
      isAdmin: true
    });

    const result = await revokeDevAdmin({
      email: 'ops@draughtbet.local',
      nodeEnv: 'development',
      dbp: mockPrisma
    });

    expect(result).toEqual({
      userId: 'dev-op-1',
      email: 'ops@draughtbet.local',
      revoked: true,
      deleted: false
    });
    expect(mockPrisma.userSession.updateMany).toHaveBeenCalled();
    expect(mockPrisma.adminRoleAssignment.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'dev-op-1' }
    });
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'dev-op-1' },
      data: { isAdmin: false, isBanned: true }
    });
  });
});
