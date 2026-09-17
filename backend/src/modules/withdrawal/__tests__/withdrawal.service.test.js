import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const makeWallet = () => ({
  id: 'wallet-1',
  userId: 'user-1',
  currency: 'NGN'
});

const eligibleUser = {
  id: 'user-1',
  countryCode: 'NG',
  kycStatus: 'VERIFIED',
  eligibility: { id: 'elig-1', countryAllowed: true, ageVerified: true }
};

const verifiedBank = {
  id: 'ba-1',
  userId: 'user-1',
  gateway: 'PAYSTACK',
  bankCode: '057',
  bankName: 'Zenith',
  accountNumber: '0123456789',
  accountName: 'John Doe',
  recipientRef: 'RCP_abc',
  verifiedAt: new Date(),
  isDefault: true
};

const withdrawalRow = (overrides = {}) => ({
  id: 'wd-1',
  userId: 'user-1',
  amountMinorUnits: 100000n,
  status: 'APPROVED',
  currency: 'NGN',
  gateway: 'PAYSTACK',
  bankAccountId: 'ba-1',
  reference: 'wit-1',
  ...overrides
});

const mockPrisma = {
  $transaction: jest.fn(),
  $queryRaw: jest.fn(),
  $executeRaw: jest.fn(),
  user: { findUnique: jest.fn() },
  wallet: { findUnique: jest.fn() },
  withdrawal: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn()
  },
  bankAccount: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    delete: jest.fn(),
    count: jest.fn()
  },
  ledgerAccount: {
    findMany: jest.fn(),
    upsert: jest.fn()
  },
  ledgerEntry: {
    aggregate: jest.fn(),
    create: jest.fn()
  },
  ledgerTransaction: {
    findUnique: jest.fn(),
    create: jest.fn()
  },
  outboxEvent: { create: jest.fn() },
  notification: { create: jest.fn() }
};

jest.unstable_mockModule('../../../utils/db.js', () => ({
  default: mockPrisma
}));

const { WithdrawalService } = await import('../service.js');

const instantiate = () => new WithdrawalService({
  providers: {
    PAYSTACK: {
      resolveBankAccount: jest.fn(),
      createRecipient: jest.fn(),
      initiatePayout: jest.fn()
    },
    FLUTTERWAVE: {
      resolveBankAccount: jest.fn(),
      createRecipient: jest.fn(),
      initiatePayout: jest.fn()
    }
  }
});

const setupRequestDefaults = () => {
  mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));
  // $queryRaw serves both the wallet FOR UPDATE lock (1 value) and the atomic
  // ledger-account upserts (user = 4 values, system singleton = 3 values).
  mockPrisma.$queryRaw.mockImplementation(async (_strings, ...values) => {
    if (values.length === 4) {
      const [id, userId, type, currency] = values;
      return [{ id: `acc-${type}`, userId, type, currency }];
    }
    if (values.length === 3) {
      const [id, type, currency] = values;
      return [{ id: `system:${type}:${currency}`, userId: null, type, currency }];
    }
    return [makeWallet()];
  });
  mockPrisma.user.findUnique.mockResolvedValue(eligibleUser);
  mockPrisma.bankAccount.findFirst.mockResolvedValue(verifiedBank);
  mockPrisma.ledgerAccount.findMany.mockResolvedValue([{ id: 'acc-avail', type: 'PLAYER_AVAILABLE' }]);
  mockPrisma.ledgerEntry.aggregate.mockResolvedValue({ _sum: { amountMinorUnits: 1000000000n } });
  mockPrisma.ledgerTransaction.findUnique.mockResolvedValue(null);
  mockPrisma.ledgerTransaction.create.mockResolvedValue({ id: 'ltx-1', entries: [] });
  mockPrisma.ledgerEntry.create.mockResolvedValue({ id: 'le-1' });
  mockPrisma.withdrawal.create.mockImplementation(({ data }) => ({ id: 'wd-1', ...data }));
  mockPrisma.outboxEvent.create.mockResolvedValue({ id: 'ob-1' });
};

describe('WithdrawalService — request/reserve path', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    setupRequestDefaults();
    service = instantiate();
  });

  it('reserves funds atomically: PENDING_REVIEW row + ledger WITHDRAWAL_RESERVE + outbox', async () => {
    const row = await service.requestWithdrawal('user-1', 100000n, 'op_key_abcdef');

    expect(row.status).toBe('PENDING_REVIEW');
    expect(row.amountMinorUnits).toBe('100000');
    expect(row.reference).toMatch(/^wit-/);
    // wallet locked before the funds check
    expect(mockPrisma.$queryRaw).toHaveBeenCalled();
    // no double-check on idempotency when key absent? key present -> one findFirst
    expect(mockPrisma.withdrawal.findFirst).toHaveBeenCalledWith({
      where: { userId: 'user-1', idempotencyKey: 'op_key_abcdef' }
    });
    // ledger reserve posted with a per-withdrawal idempotency key
    expect(mockPrisma.ledgerTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'WITHDRAWAL_RESERVE', idempotencyKey: expect.stringMatching(/^withdrawal:reserve:/) }) })
    );
    expect(mockPrisma.outboxEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ eventType: 'wallet.updated' }) })
    );
  });

  it('rejects non-canonical amounts before touching the DB', async () => {
    for (const bad of [0, '100.50', -50, 1.5]) {
      await expect(service.requestWithdrawal('user-1', bad)).rejects.toThrow('Invalid amount');
    }
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('fails loudly when the ledger PLAYER_AVAILABLE does not cover the amount', async () => {
    mockPrisma.ledgerEntry.aggregate.mockResolvedValue({ _sum: { amountMinorUnits: 40000n } });
    await expect(service.requestWithdrawal('user-1', 100000n)).rejects.toThrow('Insufficient funds');
    expect(mockPrisma.withdrawal.create).not.toHaveBeenCalled();
  });

  it('blocks ineligible accounts (KYC) before locking the wallet', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ ...eligibleUser, kycStatus: 'NONE' });
    await expect(service.requestWithdrawal('user-1', 100000n)).rejects.toThrow('KYC verification is required');
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('requires a verified payout destination', async () => {
    mockPrisma.bankAccount.findFirst.mockResolvedValue(null);
    await expect(service.requestWithdrawal('user-1', 100000n)).rejects.toThrow('A verified bank account is required');
    expect(mockPrisma.withdrawal.create).not.toHaveBeenCalled();
  });

  it('rejects an unverified bank account even when present', async () => {
    mockPrisma.bankAccount.findFirst.mockResolvedValue({ ...verifiedBank, verifiedAt: null, recipientRef: null });
    await expect(service.requestWithdrawal('user-1', 100000n)).rejects.toThrow('has not been verified');
    expect(mockPrisma.withdrawal.create).not.toHaveBeenCalled();
  });

  it('returns the original request on an idempotent replay without re-reserving', async () => {
    mockPrisma.withdrawal.findFirst.mockResolvedValue({ id: 'wd-orig', status: 'PENDING_REVIEW', amountMinorUnits: 100000n });
    const row = await service.requestWithdrawal('user-1', 100000n, 'op_key_abcdef');
    expect(row.id).toBe('wd-orig');
    expect(mockPrisma.withdrawal.create).not.toHaveBeenCalled();
    expect(mockPrisma.ledgerTransaction.create).not.toHaveBeenCalled();
  });

  it('resolves a (userId, idempotencyKey) race back to the winner without re-reserving', async () => {
    mockPrisma.withdrawal.findFirst
      .mockResolvedValueOnce(undefined) // in-tx check misses
      .mockResolvedValue({ id: 'wd-winner', status: 'PENDING_REVIEW', amountMinorUnits: 100000n });
    mockPrisma.withdrawal.create.mockRejectedValue({ code: 'P2002' });

    const row = await service.requestWithdrawal('user-1', 100000n, 'op_key_abcdef');
    expect(row.id).toBe('wd-winner');
    expect(mockPrisma.ledgerTransaction.create).not.toHaveBeenCalled();
  });

  it('rejects malformed idempotency keys before any money code', async () => {
    await expect(service.requestWithdrawal('user-1', 100000n, 'short')).rejects.toThrow('Invalid idempotency key');
    await expect(service.requestWithdrawal('user-1', 100000n, 'has space keys')).rejects.toThrow('Invalid idempotency key');
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('WithdrawalService — provider-gated payout transitions', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    setupRequestDefaults();
    service = instantiate();
  });

  it('approves only a PENDING_REVIEW withdrawal (conditional, reviewedBy set)', async () => {
    mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));
    mockPrisma.withdrawal.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.withdrawal.findUnique.mockResolvedValue(withdrawalRow({ status: 'APPROVED', reviewedBy: undefined }));

    const row = await service.approveWithdrawal('wd-1', 'admin-1');
    expect(mockPrisma.withdrawal.updateMany).toHaveBeenCalledWith({
      where: { id: 'wd-1', status: 'PENDING_REVIEW' },
      data: { status: 'APPROVED', reviewedBy: 'admin-1', reviewedAt: expect.any(Date) }
    });
    expect(row.status).toBe('APPROVED');
  });

  it('refuses a second begin-payout (CAS loser must not call the provider twice)', async () => {
    const PROVIDER = { initiatePayout: jest.fn() };
    const withFake = () => new WithdrawalService({ providers: { PAYSTACK: PROVIDER } });

    // pre-read says APPROVED, but the CAS loses (a racing admin already claimed
    // PROCESSING), so beginPayout must return the current row and NOT initiate.
    mockPrisma.withdrawal.findUnique
      .mockResolvedValueOnce(withdrawalRow())
      .mockResolvedValueOnce(withdrawalRow({ status: 'PROCESSING', providerRef: null }));
    mockPrisma.bankAccount.findUnique.mockResolvedValue(verifiedBank);
    mockPrisma.withdrawal.updateMany.mockResolvedValue({ count: 0 });

    const row = await withFake().beginPayout('wd-1');

    expect(row.status).toBe('PROCESSING');
    expect(PROVIDER.initiatePayout).not.toHaveBeenCalled();
  });

  it('marks a withdrawal FAILED when the provider rejects the payout initiation', async () => {
    const PROVIDER = { initiatePayout: jest.fn().mockRejectedValue(new Error('balance too low')) };
    const withFake = () => new WithdrawalService({ providers: { PAYSTACK: PROVIDER } });

    mockPrisma.withdrawal.findUnique
      .mockResolvedValueOnce(withdrawalRow())
      .mockResolvedValueOnce(withdrawalRow({ status: 'PROCESSING', providerRef: null }));
    mockPrisma.bankAccount.findUnique.mockResolvedValue(verifiedBank);
    mockPrisma.withdrawal.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.withdrawal.update.mockResolvedValue(withdrawalRow({ status: 'FAILED', failureReason: 'balance too low' }));

    const row = await withFake().beginPayout('wd-1');

    expect(PROVIDER.initiatePayout).toHaveBeenCalledWith({
      amountMinorUnits: 100000n,
      currency: 'NGN',
      recipientRef: 'RCP_abc',
      reference: 'wit-1'
    });
    expect(row.status).toBe('FAILED');
  });

  it('completes a PROCESSING payout exactly once via CAS: ledger posting + notification', async () => {
    mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));
    // First findUnique (pre-read) is PROCESSING; the CAS wins; final read returns COMPLETED.
    mockPrisma.withdrawal.findUnique
      .mockResolvedValueOnce(withdrawalRow({ status: 'PROCESSING' }))
      .mockResolvedValueOnce(withdrawalRow({ status: 'COMPLETED' }));
    mockPrisma.withdrawal.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.ledgerTransaction.findUnique.mockResolvedValue(null);
    mockPrisma.ledgerTransaction.create.mockResolvedValue({ id: 'ltx-2', entries: [] });
    mockPrisma.ledgerEntry.create.mockResolvedValue({ id: 'le-2' });
    mockPrisma.notification.create.mockResolvedValue({ id: 'notif-1' });

    const row = await service.reportPayoutResult('wd-1', { success: true });

    expect(row.status).toBe('COMPLETED');
    // The CAS is the gate: only a winning PROCESSING claim proceeds.
    expect(mockPrisma.withdrawal.updateMany).toHaveBeenCalledWith({
      where: { id: 'wd-1', status: 'PROCESSING' },
      data: { status: 'COMPLETED' }
    });
    // WITHDRAWAL_COMPLETE ledger posting with per-withdrawal idempotency key.
    expect(mockPrisma.ledgerTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'WITHDRAWAL_COMPLETE', idempotencyKey: expect.stringMatching(/^withdrawal:complete:/) }) })
    );
    expect(mockPrisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'WITHDRAWAL_CONFIRMED' }) })
    );
  });

  it('treats a concurrent duplicate success callback as a no-op (CAS loser)', async () => {
    mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));
    // Pre-read saw PROCESSING, but the CAS lost to a racing callback that
    // already terminalized the row as COMPLETED.
    mockPrisma.withdrawal.findUnique
      .mockResolvedValueOnce(withdrawalRow({ status: 'PROCESSING' }))
      .mockResolvedValueOnce(withdrawalRow({ status: 'COMPLETED' }));
    mockPrisma.withdrawal.updateMany.mockResolvedValue({ count: 0 });

    const row = await service.reportPayoutResult('wd-1', { success: true });

    expect(row.status).toBe('COMPLETED');
    expect(mockPrisma.ledgerTransaction.create).not.toHaveBeenCalled();
    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
  });

  it('rejects reporting a payout result for a non-PROCESSING withdrawal', async () => {
    mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));
    mockPrisma.withdrawal.findUnique.mockResolvedValue(withdrawalRow({ status: 'APPROVED' }));
    mockPrisma.withdrawal.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.reportPayoutResult('wd-1', { success: true })).rejects.toThrow(
      /Payout result can only be reported for a PROCESSING withdrawal/
    );
    expect(mockPrisma.ledgerTransaction.create).not.toHaveBeenCalled();
    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
  });

  it('releases only releasable statuses (never PROCESSING)', async () => {
    mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));
    mockPrisma.withdrawal.findUnique.mockResolvedValue({ id: 'wd-1', userId: 'user-1', amountMinorUnits: 100000n, status: 'PROCESSING', currency: 'NGN', gateway: 'PAYSTACK' });

    await expect(service.releaseWithdrawal('wd-1')).rejects.toThrow(/Resolve the payout result/);
    expect(mockPrisma.ledgerTransaction.create).not.toHaveBeenCalled();
  });
});