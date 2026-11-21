import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { generateTotp } from '../../../utils/totp.js';

const mockPrisma = {
  $transaction: jest.fn(async (cb) => cb(mockPrisma)),
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
  status: 'end',
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  incr: jest.fn(),
  ttl: jest.fn(),
  expire: jest.fn()
};

jest.unstable_mockModule('../../../utils/db.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../../utils/redis.js', () => ({
  default: mockRedis,
  isRedisReady: () => false
}));
jest.unstable_mockModule('../../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

const {
  AdminMfaService,
  MFA_FAIL_LIMIT,
  AdminMfaCodeError,
  AdminMfaStateError,
  AdminMfaNotFoundError,
  AdminMfaLockedError
} = await import('../service.js');

describe('AdminMfaService (TOTP, Encryption, Recovery Codes, Brute-Force Lockout)', () => {
  let storedRow;

  beforeEach(() => {
    jest.clearAllMocks();
    storedRow = null;
    AdminMfaService.clearLocalState();
    mockRedis.get.mockResolvedValue(null);
    mockRedis.incr.mockResolvedValue(1);
    mockRedis.ttl.mockResolvedValue(-1);

    mockPrisma.user.findUnique.mockResolvedValue({ id: 'admin-1', email: 'ops@draughtbet.com' });
    mockPrisma.adminMfa.findUnique.mockImplementation(async () => storedRow);
    mockPrisma.adminMfa.upsert.mockImplementation(async ({ create, update }) => {
      storedRow = storedRow ? { ...storedRow, ...update } : { id: 'mfa-1', ...create };
      return storedRow;
    });
    mockPrisma.adminMfa.update.mockImplementation(async ({ data }) => {
      storedRow = { ...storedRow, ...data };
      return storedRow;
    });
    mockPrisma.adminMfa.delete.mockImplementation(async () => {
      const prev = storedRow;
      storedRow = null;
      return prev;
    });
  });

  it('provisions encrypted TOTP secret and 8 single-use recovery codes without storing plaintext', async () => {
    const provisioned = await AdminMfaService.provision('admin-1');

    expect(provisioned.base32).toMatch(/^[A-Z2-7]{32}$/);
    expect(provisioned.otpauthUrl).toContain('otpauth://totp/');
    expect(provisioned.recoveryCodes).toHaveLength(8);
    expect(new Set(provisioned.recoveryCodes).size).toBe(8);

    // Ciphertext format: iv.tag.ciphertext, never containing plaintext secret or recovery codes
    expect(storedRow.secretEnc.split('.')).toHaveLength(3);
    expect(storedRow.secretEnc).not.toContain(provisioned.base32);
    for (const rc of provisioned.recoveryCodes) {
      expect(storedRow.secretEnc).not.toContain(rc);
      expect(storedRow.secretEnc).not.toContain(rc.replace(/-/g, ''));
    }

    const status = await AdminMfaService.getDetailedStatus('admin-1');
    expect(status.provisioned).toBe(true);
    expect(status.enabled).toBe(false);
    expect(status.recoveryCodesRemaining).toBe(8);
  });

  it('enables MFA only with a valid TOTP code and blocks re-enabling', async () => {
    const { base32 } = await AdminMfaService.provision('admin-1');

    await expect(AdminMfaService.enable('admin-1', '000000')).rejects.toThrow(AdminMfaCodeError);

    const validCode = generateTotp(base32);
    await AdminMfaService.enable('admin-1', validCode);

    const status = await AdminMfaService.getStatus('admin-1');
    expect(status).toEqual({ provisioned: true, enabled: true });

    await expect(AdminMfaService.enable('admin-1', validCode)).rejects.toThrow(AdminMfaStateError);
  });

  it('blocks overwriting an already-enabled MFA secret without proving current TOTP code', async () => {
    const { base32 } = await AdminMfaService.provision('admin-1');
    await AdminMfaService.enable('admin-1', generateTotp(base32));

    await expect(AdminMfaService.provision('admin-1')).rejects.toThrow(AdminMfaCodeError);
    await expect(
      AdminMfaService.provision('admin-1', { currentCode: '999999' })
    ).rejects.toThrow(AdminMfaCodeError);

    // Valid current code permits controlled re-enrollment and resets enabledAt until verified
    const reenrolled = await AdminMfaService.provision('admin-1', {
      currentCode: generateTotp(base32)
    });
    expect(reenrolled.base32).not.toBe(base32);
    expect((await AdminMfaService.getStatus('admin-1')).enabled).toBe(false);
  });

  it('prevents TOTP replay within the same 30s time step for session verification', async () => {
    const { base32 } = await AdminMfaService.provision('admin-1');
    // Enable using an earlier time step simulation by calling verify on a fresh timestamp
    await AdminMfaService.enable('admin-1', generateTotp(base32, { timestamp: Date.now() - 30_000 }));

    const currentCode = generateTotp(base32);
    expect(await AdminMfaService.verify('admin-1', currentCode)).toBe(true);
    // Replay of same 30-second step rejected for session elevation
    expect(await AdminMfaService.verify('admin-1', currentCode)).toBe(false);
    // Per-request header mode explicitly allows same-window reuse
    expect(
      await AdminMfaService.verify('admin-1', currentCode, { allowReplayWithinStep: true })
    ).toBe(true);
  });

  it('consumes single-use recovery codes permanently and supports regeneration', async () => {
    const { base32, recoveryCodes } = await AdminMfaService.provision('admin-1');
    await AdminMfaService.enable('admin-1', generateTotp(base32));

    const first = await AdminMfaService.verifyRecoveryCode('admin-1', recoveryCodes[0]);
    expect(first).toEqual({ verified: true, recoveryCodesRemaining: 7 });

    // Replaying the same recovery code MUST fail
    await expect(
      AdminMfaService.verifyRecoveryCode('admin-1', recoveryCodes[0])
    ).rejects.toThrow(AdminMfaCodeError);

    // Regenerating requires valid TOTP and invalidates all previous codes
    const regen = await AdminMfaService.regenerateRecoveryCodes('admin-1', generateTotp(base32));
    expect(regen.recoveryCodes).toHaveLength(8);
    expect(regen.recoveryCodesRemaining).toBe(8);

    await expect(
      AdminMfaService.verifyRecoveryCode('admin-1', recoveryCodes[1])
    ).rejects.toThrow(AdminMfaCodeError);

    const newOk = await AdminMfaService.verifyRecoveryCode('admin-1', regen.recoveryCodes[0]);
    expect(newOk).toEqual({ verified: true, recoveryCodesRemaining: 7 });
  });

  it('locks admin MFA after 5 consecutive failures even when Redis is unavailable', async () => {
    const { base32 } = await AdminMfaService.provision('admin-1');
    await AdminMfaService.enable('admin-1', generateTotp(base32, { timestamp: Date.now() - 30_000 }));

    for (let i = 0; i < MFA_FAIL_LIMIT; i += 1) {
      await AdminMfaService.recordFailure('admin-1');
    }

    expect(await AdminMfaService.isLocked('admin-1')).toBe(true);
    // Even a valid code fails while locked
    expect(await AdminMfaService.verify('admin-1', generateTotp(base32))).toBe(false);
    await expect(AdminMfaService.disable('admin-1', generateTotp(base32))).rejects.toThrow(
      AdminMfaLockedError
    );
  });

  it('disables MFA with a valid code and throws NotFound when absent', async () => {
    await expect(AdminMfaService.disable('admin-1', '123456')).rejects.toThrow(AdminMfaNotFoundError);

    const { base32 } = await AdminMfaService.provision('admin-1');
    await AdminMfaService.enable('admin-1', generateTotp(base32));

    await expect(AdminMfaService.disable('admin-1', '000000')).rejects.toThrow(AdminMfaCodeError);
    expect(await AdminMfaService.disable('admin-1', generateTotp(base32))).toBe(true);
    expect(await AdminMfaService.getStatus('admin-1')).toEqual({ provisioned: false, enabled: false });
  });
});
