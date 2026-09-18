import { jest } from '@jest/globals';
import { generateSecret, generateSync } from 'otplib';

const mockPrisma = {
  user: {
    findUnique: jest.fn()
  },
  adminMfa: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn()
  }
};

const mockRedis = {
  get: jest.fn(),
  del: jest.fn(),
  incr: jest.fn(),
  ttl: jest.fn(),
  expire: jest.fn()
};
mockRedis.get.mockResolvedValue(null);
mockRedis.incr.mockResolvedValue(1);
mockRedis.ttl.mockResolvedValue(-1);

jest.unstable_mockModule('../../../utils/db.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../../utils/redis.js', () => ({ default: mockRedis }));
jest.unstable_mockModule('../../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

const {
  AdminMfaService,
  getAdminMfaStatus,
  provisionAdminMfa,
  enableAdminMfa,
  disableAdminMfa,
  verifyAdminMfaCode,
  isMfaLocked,
  recordMfaFailure,
  revokeMfaFailedCount,
  MFA_FAIL_LIMIT,
  mfaStatusView,
  AdminMfaNotFoundError,
  AdminMfaStateError,
  AdminMfaCodeError
} = await import('../service.js');
const { encryptMfaSecret } = await import('../../../utils/mfaSecrets.js');

const secret = generateSecret();

const rowFor = (overrides = {}) => ({
  userId: 'admin-1',
  secretEnc: encryptMfaSecret(secret),
  enabledAt: new Date(0),
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides
});

const enabledRow = () => rowFor({ enabledAt: new Date(Date.now() - 60_000) });

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.ADMIN_MFA_SECRET_KEY;
  mockPrisma.user.findUnique.mockResolvedValue({ id: 'admin-1', email: 'admin@example.com' });
  mockPrisma.adminMfa.findUnique.mockResolvedValue(null);
});

describe('mfaStatusView', () => {
  it('reports enabled only once enabledAt is a real timestamp', () => {
    expect(mfaStatusView(null)).toEqual({ provisioned: false, enabled: false });
    expect(mfaStatusView(rowFor())).toEqual({ provisioned: true, enabled: false });
    expect(mfaStatusView(enabledRow())).toEqual({ provisioned: true, enabled: true });
  });

  it('surfaces status through getAdminMfaStatus', async () => {
    mockPrisma.adminMfa.findUnique.mockResolvedValue(enabledRow());
    await expect(getAdminMfaStatus('admin-1')).resolves.toEqual({ provisioned: true, enabled: true });
  });
});

describe('provisionAdminMfa', () => {
  it('upserts an encrypted secret and returns the bare otpauth payload', async () => {
    const out = await provisionAdminMfa('admin-1');

    expect(mockPrisma.adminMfa.upsert).toHaveBeenCalledTimes(1);
    const args = mockPrisma.adminMfa.upsert.mock.calls[0][0];
    expect(args.where).toEqual({ userId: 'admin-1' });
    expect(args.create.enabledAt.getTime()).toBe(0);
    expect(args.create.secretEnc).not.toBe(out.base32);
    expect(args.create.secretEnc).not.toContain(out.base32);

    expect(out.base32).toBeTruthy();
    expect(out.otpauthUrl).toContain('otpauth://totp/');
    expect(out.otpauthUrl).toContain('admin%40example.com');
  });

  it('re-rolls the secret for an already-enabled admin', async () => {
    mockPrisma.adminMfa.findUnique.mockResolvedValue(enabledRow());
    const before = mockPrisma.adminMfa.upsert.mock.calls.length;
    await provisionAdminMfa('admin-1');
    expect(mockPrisma.adminMfa.upsert).toHaveBeenCalledTimes(before + 1);
  });

  it('throws when the admin account does not exist', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    await expect(provisionAdminMfa('ghost')).rejects.toBeInstanceOf(AdminMfaNotFoundError);
    expect(mockPrisma.adminMfa.upsert).not.toHaveBeenCalled();
  });
});

describe('enableAdminMfa', () => {
  it('activates a provisioned-but-not-enabled admin with the current code', async () => {
    mockPrisma.adminMfa.findUnique.mockResolvedValue(rowFor());
    const code = generateSync({ secret });
    await enableAdminMfa('admin-1', code);
    const args = mockPrisma.adminMfa.update.mock.calls[0][0];
    expect(args.where).toEqual({ userId: 'admin-1' });
    expect(args.data.enabledAt).toBeInstanceOf(Date);
  });

  it('rejects when nothing is provisioned', async () => {
    await expect(enableAdminMfa('admin-1', '123456')).rejects.toBeInstanceOf(AdminMfaNotFoundError);
  });

  it('rejects when already enabled', async () => {
    mockPrisma.adminMfa.findUnique.mockResolvedValue(enabledRow());
    await expect(enableAdminMfa('admin-1', generateSync({ secret }))).rejects.toBeInstanceOf(AdminMfaStateError);
  });

  it('rejects a wrong code', async () => {
    mockPrisma.adminMfa.findUnique.mockResolvedValue(rowFor());
    await expect(enableAdminMfa('admin-1', '000000')).rejects.toBeInstanceOf(AdminMfaCodeError);
    expect(mockPrisma.adminMfa.update).not.toHaveBeenCalled();
  });
});

describe('disableAdminMfa', () => {
  it('deletes the row only with a valid code', async () => {
    mockPrisma.adminMfa.findUnique.mockResolvedValue(enabledRow());
    await disableAdminMfa('admin-1', generateSync({ secret }));
    expect(mockPrisma.adminMfa.delete).toHaveBeenCalledWith({ where: { userId: 'admin-1' } });
    expect(mockRedis.del).toHaveBeenCalledWith('mfa:fail:admin-1');
  });

  it('rejects a wrong code without deleting', async () => {
    mockPrisma.adminMfa.findUnique.mockResolvedValue(enabledRow());
    await expect(disableAdminMfa('admin-1', '000000')).rejects.toBeInstanceOf(AdminMfaCodeError);
    expect(mockPrisma.adminMfa.delete).not.toHaveBeenCalled();
  });
});

describe('verifyAdminMfaCode', () => {
  it('touches lastVerifiedAt and clears failures on a valid code', async () => {
    mockPrisma.adminMfa.findUnique.mockResolvedValue(enabledRow());
    await expect(verifyAdminMfaCode('admin-1', generateSync({ secret }))).resolves.toBe(true);
    const args = mockPrisma.adminMfa.update.mock.calls[0][0];
    expect(args.data.lastVerifiedAt).toBeInstanceOf(Date);
    expect(mockRedis.del).toHaveBeenCalledWith('mfa:fail:admin-1');
  });

  it('returns false for a wrong code without a DB write', async () => {
    mockPrisma.adminMfa.findUnique.mockResolvedValue(enabledRow());
    await expect(verifyAdminMfaCode('admin-1', '000000')).resolves.toBe(false);
    expect(mockPrisma.adminMfa.update).not.toHaveBeenCalled();
  });

  it('returns false when nothing is provisioned', async () => {
    await expect(verifyAdminMfaCode('admin-1', '000000')).resolves.toBe(false);
  });
});

describe('failure lock', () => {
  it('locks only at the threshold', async () => {
    mockRedis.get.mockResolvedValue(String(MFA_FAIL_LIMIT - 1));
    await expect(isMfaLocked('admin-1')).resolves.toBe(false);
    mockRedis.get.mockResolvedValue(String(MFA_FAIL_LIMIT));
    await expect(isMfaLocked('admin-1')).resolves.toBe(true);
  });

  it('records a failure with a fresh window expiry', async () => {
    mockRedis.ttl.mockResolvedValue(-1);
    await recordMfaFailure('admin-1');
    expect(mockRedis.incr).toHaveBeenCalledWith('mfa:fail:admin-1');
    expect(mockRedis.expire).toHaveBeenCalledWith('mfa:fail:admin-1', expect.any(Number));
  });

  it('does not extend an already-running window', async () => {
    mockRedis.ttl.mockResolvedValue(500);
    await recordMfaFailure('admin-1');
    expect(mockRedis.expire).not.toHaveBeenCalled();
  });

  it('resets the count', async () => {
    await revokeMfaFailedCount('admin-1');
    expect(mockRedis.del).toHaveBeenCalledWith('mfa:fail:admin-1');
  });
});

describe('AdminMfaService surface', () => {
  it('exposes the full API used by requireAdminMfa', () => {
    expect(AdminMfaService.getStatus).toBe(getAdminMfaStatus);
    expect(AdminMfaService.verify).toBe(verifyAdminMfaCode);
    expect(AdminMfaService.isLocked).toBe(isMfaLocked);
    expect(AdminMfaService.recordFailure).toBe(recordMfaFailure);
    expect(AdminMfaService.clearFailures).toBe(revokeMfaFailedCount);
  });
});