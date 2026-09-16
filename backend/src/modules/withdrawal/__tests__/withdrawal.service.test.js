import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const WALLET_BILLION = '1000000000';

const makeWallet = (balance = WALLET_BILLION) => ({
  id: 'wallet-1',
  userId: 'user-1',
  balanceMinorUnits: BigInt(balance),
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
  wallet: {
    findUnique: jest.fn(),
    update: jest.fn()
  },
  walletTransaction: { create: jest.fn() },
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
  mockPrisma.$queryRaw.mockResolvedValue([makeWallet()]);
  mockPrisma.user.findUnique.mockResolvedValue(eligibleUser);
  mockPrisma.bankAccount.findFirst.mockResolvedValue(verifiedBank);
  mockPrisma.ledgerAccount.findMany.mockResolvedValue([{ id: 'acc-avail', type: 'PLAYER_AVAILABLE' }]);
  mockPrisma.ledgerEntry.aggregate.mockResolvedValue({ _sum: { amountMinorUnits: 1000000000n } });
  mockPrisma.ledgerAccount.upsert.mockImplementation(({ create }) => ({ id: `acc-${create.type}`, ...create }));
  mockPrisma.ledgerTransaction.findUnique.mockResolvedValue(null);
  mockPrisma.ledgerTransaction.create.mockResolvedValue({ id: 'ltx-1', entries: [] });
  mockPrisma.ledgerEntry.create.mockResolvedValue({ id: 'le-1' });
  mockPrisma.withdrawal.create.mockImplementation(({ data }) => ({ id: 'wd-1', ...data }));
  mockPrisma.wallet.update.mockResolvedValue({ id: 'wallet-1' });
  mockPrisma.walletTransaction.create.mockResolvedValue({ id: 'wt-1' });
  mockPrisma.outboxEvent.create.mockResolvedValue({ id: 'ob-1' });
};

describe('WithdrawalService — request/reserve path', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    setupRequestDefaults();
    service = instantiate();
  });

  it('reserves funds atomically: PENDING_REVIEW row + wallet debit + ledger WITHDRAWAL_RESERVE + outbox', async () => {
    const row = await service.requestWithdrawal('user-1', 100000n, 'op_key_abcdef');

    expect(row.status).toBe('PENDING_REVIEW');
    expect(row.amountMinorUnits).toBe('100000');
    expect(row.reference).toMatch(/^wit-/);
    // wallet locked before the balance check
    expect(mockPrisma.$queryRaw).toHaveBeenCalled();
    // no double-check on idempotency when key absent? key present -> one findFirst
    expect(mockPrisma.withdrawal.findFirst).toHaveBeenCalledWith({
      where: { userId: 'user-1', idempotencyKey: 'op_key_abcdef' }
    });
    expect(mockPrisma.wallet.update).toHaveBeenCalledWith({
      where: { id: 'wallet-1' },
      data: { balanceMinorUnits: { decrement: 100000n } }
    });
    expect(mockPrisma.walletTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'WITHDRAWAL', amountMinorUnits: -100000n }) })
    );
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

  it('throws InsufficientFundsError and never debits when the wallet cannot cover it', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([makeWallet('50000')]);
    await expect(service.requestWithdrawal('user-1', 100000n)).rejects.toThrow('Insufficient funds');
    expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
    expect(mockPrisma.walletTransaction.create).not.toHaveBeenCalled();
  });

  it('fails loudly if the ledger PLAYER_AVAILABLE does not cover the amount', async () => {
    mockPrisma.ledgerEntry.aggregate.mockResolvedValue({ _sum: { amountMinorUnits: 40000n } });
    await expect(service.requestWithdrawal('user-1', 100000n)).rejects.toThrow('Insufficient funds');
    expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
  });

  it('blocks ineligible accounts (KYC) before locking the wallet', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ ...eligibleUser, kycStatus: 'NONE' });
    await expect(service.requestWithdrawal('user-1', 100000n)).rejects.toThrow('KYC verification is required');
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('requires a verified payout destination', async () => {
    mockPrisma.bankAccount.findFirst.mockResolvedValue(null);
    await expect(service.requestWithdrawal('user-1', 100000n)).rejects.toThrow('A verified bank account is required');
    expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
  });

  it('rejects an unverified bank account even when present', async () => {
    mockPrisma.bankAccount.findFirst.mockResolvedValue({ ...verifiedBank, verifiedAt: null, recipientRef: null });
    await expect(service.requestWithdrawal('user-1', 100000n)).rejects.toThrow('has not been verified');
    expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
  });

  it('returns the original request on an idempotent replay without re-debiting', async () => {
    mockPrisma.withdrawal.findFirst.mockResolvedValue({ id: 'wd-orig', status: 'PENDING_REVIEW', amountMinorUnits: 100000n });
    const row = await service.requestWithdrawal('user-1', 100000n, 'op_key_abcdef');
    expect(row.id).toBe('wd-orig');
    expect(mockPrisma.withdrawal.create).not.toHaveBeenCalled();
    expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
  });

  it('resolves a (userId, idempotencyKey) race back to the winner without re-debiting', async () => {
    mockPrisma.withdrawal.findFirst
      .mockResolvedValueOnce(undefined) // in-tx check misses
      .mockResolvedValue({ id: 'wd-winner', status: 'PENDING_REVIEW', amountMinorUnits: 100000n });
    mockPrisma.withdrawal.create.mockRejectedValue({ code: 'P2002' });

    const row = await service.requestWithdrawal('user-1', 100000n, 'op_key_abcdef');
    expect(row.id).toBe('wd-winner');
    expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
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

  it('releases only releasable statuses (never PROCESSING)', async () => {
    mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));
    mockPrisma.withdrawal.findUnique.mockResolvedValue({ id: 'wd-1', userId: 'user-1', amountMinorUnits: 100000n, status: 'PROCESSING', currency: 'NGN', gateway: 'PAYSTACK' });

    await expect(service.releaseWithdrawal('wd-1')).rejects.toThrow(/Resolve the payout result/);
    expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
  });
});