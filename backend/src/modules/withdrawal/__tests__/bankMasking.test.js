import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import {
  maskAccountNumber,
  getAccountNumberLast4,
  serializeBankAccountForPlayer,
  serializeBankAccountForAdmin
} from '../../../utils/bankMask.js';
import { redactValue, CENSOR } from '../../../utils/logger.js';

const mockPrisma = {
  $transaction: jest.fn(async (cb) => cb(mockPrisma)),
  bankAccount: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    updateMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn()
  },
  withdrawal: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    count: jest.fn()
  }
};

jest.unstable_mockModule('../../../utils/db.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

const { WithdrawalService } = await import('../service.js');

describe('Bank Account Masking & Minimal Disclosure (Issue #6)', () => {
  const rawBankRow = {
    id: 'bank-1',
    userId: 'user-1',
    gateway: 'PAYSTACK',
    bankCode: '058',
    bankName: 'GTBank',
    accountNumber: '0123456789',
    accountName: 'ADA LOVELACE',
    verifiedName: 'ADA LOVELACE',
    recipientRef: 'RCP_secret_provider_ref_999',
    isDefault: true,
    verifiedAt: new Date('2026-11-01T00:00:00Z'),
    createdAt: new Date('2026-11-01T00:00:00Z')
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('masks account numbers down to last 4 digits and fully masks short strings', () => {
    expect(maskAccountNumber('0123456789')).toBe('******6789');
    expect(maskAccountNumber('123456')).toBe('****3456');
    expect(maskAccountNumber('1234')).toBe('****');
    expect(maskAccountNumber('12')).toBe('****');
    expect(maskAccountNumber('')).toBeNull();
    expect(maskAccountNumber(null)).toBeNull();
    expect(getAccountNumberLast4('0123456789')).toBe('6789');
  });

  it('player and admin serializers mask accountNumber and never expose recipientRef', () => {
    const playerView = serializeBankAccountForPlayer(rawBankRow);
    expect(playerView.accountNumber).toBe('******6789');
    expect(playerView.maskedAccountNumber).toBe('******6789');
    expect(playerView.accountNumberLast4).toBe('6789');
    expect(playerView).not.toHaveProperty('recipientRef');
    expect(playerView).not.toHaveProperty('userId');
    expect(JSON.stringify(playerView)).not.toContain('0123456789');
    expect(JSON.stringify(playerView)).not.toContain('RCP_secret_provider_ref_999');

    const adminView = serializeBankAccountForAdmin(rawBankRow);
    expect(adminView.accountNumber).toBe('******6789');
    expect(adminView.accountNumberLast4).toBe('6789');
    expect(adminView).not.toHaveProperty('recipientRef');
    expect(JSON.stringify(adminView)).not.toContain('0123456789');
    expect(JSON.stringify(adminView)).not.toContain('RCP_secret_provider_ref_999');
  });

  it('WithdrawalService list/create/setDefault/admin getters never leak full account numbers or recipientRef', async () => {
    const provider = {
      resolveBankAccount: jest.fn().mockResolvedValue({ accountName: 'ADA LOVELACE', verified: true }),
      createRecipient: jest.fn().mockResolvedValue({ recipientRef: 'RCP_secret_provider_ref_999' })
    };
    const svc = new WithdrawalService({ providers: { PAYSTACK: provider } });

    mockPrisma.bankAccount.findFirst.mockResolvedValueOnce(null);
    mockPrisma.bankAccount.count.mockResolvedValueOnce(0);
    mockPrisma.bankAccount.updateMany.mockResolvedValueOnce({ count: 0 });
    mockPrisma.bankAccount.create.mockResolvedValueOnce(rawBankRow);

    const created = await svc.createBankAccount('user-1', {
      gateway: 'PAYSTACK',
      bankCode: '058',
      bankName: 'GTBank',
      accountNumber: '0123456789'
    });
    expect(created.accountNumber).toBe('******6789');
    expect(created).not.toHaveProperty('recipientRef');
    expect(JSON.stringify(created)).not.toContain('0123456789');

    mockPrisma.bankAccount.findMany.mockResolvedValueOnce([rawBankRow]);
    const list = await svc.listBankAccounts('user-1');
    expect(list[0].accountNumber).toBe('******6789');
    expect(JSON.stringify(list)).not.toContain('0123456789');
    expect(JSON.stringify(list)).not.toContain('RCP_secret_provider_ref_999');

    mockPrisma.bankAccount.findFirst.mockResolvedValueOnce(rawBankRow);
    mockPrisma.bankAccount.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.bankAccount.update.mockResolvedValueOnce(rawBankRow);
    const def = await svc.setDefaultBankAccount('user-1', 'bank-1');
    expect(def.accountNumber).toBe('******6789');
    expect(def).not.toHaveProperty('recipientRef');

    mockPrisma.withdrawal.findUnique.mockResolvedValueOnce({
      id: 'w-1',
      userId: 'user-1',
      amountMinorUnits: 50000n,
      currency: 'NGN',
      reference: 'wit-1',
      gateway: 'PAYSTACK',
      status: 'PENDING_REVIEW',
      bankAccountId: 'bank-1',
      bankAccount: rawBankRow,
      user: { id: 'user-1', email: 'ada@example.com' }
    });
    const detail = await svc.getWithdrawal('w-1');
    expect(detail.bankAccount.accountNumber).toBe('******6789');
    expect(JSON.stringify(detail)).not.toContain('0123456789');
    expect(JSON.stringify(detail)).not.toContain('RCP_secret_provider_ref_999');
  });

  it('logger redaction scrubs bank account numbers, recipientRef, and MFA secrets at any depth', () => {
    const logObj = {
      nested: {
        accountNumber: '0123456789',
        account_number: '0123456789',
        recipientRef: 'RCP_secret_provider_ref_999',
        base32: 'JBSWY3DPEHPK3PXP',
        recoveryCodes: ['ABCD-EFGH-1234']
      }
    };
    redactValue(logObj);
    expect(logObj.nested.accountNumber).toBe(CENSOR);
    expect(logObj.nested.account_number).toBe(CENSOR);
    expect(logObj.nested.recipientRef).toBe(CENSOR);
    expect(logObj.nested.base32).toBe(CENSOR);
    expect(logObj.nested.recoveryCodes).toBe(CENSOR);
  });
});
