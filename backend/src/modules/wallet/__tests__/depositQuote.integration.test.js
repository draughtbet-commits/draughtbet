// Real-PostgreSQL integration test for the deposit quote contract.
//
// The quote is what stops the client inventing fees and gateways, and the claim
// gate is what stops one quote opening two checkouts. Both are enforced by real
// database constraints (the composite unique on the client key, the unique on
// consumedByIntentId, the conditional updateMany), so they are only genuinely
// proven here and not against a mock.
//
//   DATABASE_URL=postgresql://… REDIS_URL= RUN_DB_INTEGRATION=1 \
//   node --experimental-vm-modules node_modules/jest/bin/jest.js \
//     src/modules/wallet/__tests__/depositQuote.integration.test.js
import prisma from '../../../utils/db.js';
import {
  createDepositQuote,
  findDepositQuoteByClientKey,
  claimDepositQuote,
  expireDepositQuotes,
  createDepositIntent,
  getDepositIntent,
  DepositQuoteError
} from '../service.js';

const describeIntegration =
  process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;

const expectQuoteError = async (promise, code) => {
  await expect(promise).rejects.toBeInstanceOf(DepositQuoteError);
  await promise.catch((err) => {
    expect(err.code).toBe(code);
  });
};

describeIntegration('Deposit quotes (real PostgreSQL)', () => {
  let userId;
  let walletId;
  let originalSettings;

  const createFixture = async (currency = 'NGN') => {
    const user = await prisma.user.create({
      data: {
        email: `dq-${Date.now()}-${Math.random()}@test.local`,
        passwordHash: 'x',
        kycStatus: 'VERIFIED',
        countryCode: 'NG',
        wallet: { create: { currency } },
        eligibility: {
          create: { countryCode: 'NG', countryAllowed: true, ageVerified: true }
        }
      },
      // A nested create does not return the created relation unless asked.
      include: { wallet: true }
    });
    userId = user.id;
    walletId = user.wallet?.id ?? null;
  };

  const POLICY_FIELDS = {
    paystackEnabled: true,
    flutterwaveEnabled: true,
    paystackFeeBps: 0,
    flutterwaveFeeBps: 0,
    depositMinP: 10000n,
    depositMaxP: 50000000n,
    depositQuoteTtlSeconds: 900
  };

  // The settings singleton may not exist on a fresh scratch database (the server
  // seeds it at boot), so upsert rather than assume — same convention as the
  // other integration suites.
  const upsertPolicy = async (fields) => {
    await prisma.platformSettings.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', ...fields },
      update: fields
    });
  };

  const setPolicy = async (fields) => {
    await prisma.platformSettings.update({
      where: { id: 'singleton' },
      data: fields
    });
  };

  const cleanup = async () => {
    if (!userId) return;
    await prisma.depositQuote.deleteMany({ where: { userId } });
    await prisma.depositIntent.deleteMany({ where: { userId } });
    // The wallet is a dependent row — it must go before the user.
    await prisma.wallet.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    userId = null;
    walletId = null;
  };

  beforeAll(async () => {
    originalSettings = await prisma.platformSettings.findUnique({
      where: { id: 'singleton' }
    });
  });

  afterAll(async () => {
    // The settings singleton is shared process-wide, so put it back exactly —
    // including removing it again if this run is what created it.
    if (originalSettings) {
      await prisma.platformSettings.update({
        where: { id: 'singleton' },
        data: {
          paystackEnabled: originalSettings.paystackEnabled,
          flutterwaveEnabled: originalSettings.flutterwaveEnabled,
          paystackFeeBps: originalSettings.paystackFeeBps,
          flutterwaveFeeBps: originalSettings.flutterwaveFeeBps,
          depositMinP: originalSettings.depositMinP,
          depositMaxP: originalSettings.depositMaxP,
          depositQuoteTtlSeconds: originalSettings.depositQuoteTtlSeconds
        }
      });
    } else {
      await prisma.platformSettings.deleteMany({ where: { id: 'singleton' } });
    }
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await upsertPolicy(POLICY_FIELDS);
  });

  afterEach(async () => {
    await cleanup();
  });

  describe('issuing', () => {
    it('computes fee and total server-side and lists the enabled gateways', async () => {
      await createFixture();

      const { quote } = await createDepositQuote(userId, '100000', undefined);

      // Launch default is a zero-fee schedule; total must equal amount exactly.
      expect(quote.amountMinorUnits).toBe(100000n);
      expect(quote.feeMinorUnits).toBe(0n);
      expect(quote.totalMinorUnits).toBe(100000n);
      expect(quote.currency).toBe('NGN');
      const methods = quote.paymentMethods;
      expect(methods.map((m) => m.id).sort()).toEqual(['flutterwave', 'paystack']);
      expect(methods.every((m) => m.feeMinorUnits === '0')).toBe(true);
    });

    it('refuses to quote a non-zero fee it cannot actually collect', async () => {
      await createFixture();
      await setPolicy({ paystackFeeBps: 250 });

      // The credit path charges and credits the same amount, so quoting a fee
      // would promise a total the checkout never takes. Failing closed is the
      // only honest option until the fee is posted as platform revenue.
      await expectQuoteError(
        createDepositQuote(userId, '100000', undefined),
        'FEE_SCHEDULE_NOT_ACTIVE'
      );
      expect(await prisma.depositQuote.count({ where: { userId } })).toBe(0);
    });

    it('ignores a fee on a disabled gateway', async () => {
      await createFixture();
      // Flutterwave is off, so its configured fee must not block the quote.
      await setPolicy({ flutterwaveEnabled: false, flutterwaveFeeBps: 500 });

      const { quote } = await createDepositQuote(userId, '100000', undefined);

      expect(quote.feeMinorUnits).toBe(0n);
      expect(quote.paymentMethods.map((m) => m.id)).toEqual(['paystack']);
    });

    it('omits a disabled gateway entirely rather than quoting it', async () => {
      await createFixture();
      await setPolicy({ flutterwaveEnabled: false });

      const { quote } = await createDepositQuote(userId, '100000', undefined);

      expect(quote.paymentMethods.map((m) => m.id)).toEqual(['paystack']);
    });

    it('refuses to quote when no gateway is enabled', async () => {
      await createFixture();
      await setPolicy({ paystackEnabled: false, flutterwaveEnabled: false });

      await expectQuoteError(createDepositQuote(userId, '100000', undefined), 'NO_GATEWAY_AVAILABLE');
    });

    it.each([
      ['0', 'zero'],
      ['-1', 'negative'],
      ['1.5', 'fractional'],
      ['abc', 'non-numeric']
    ])('rejects amount %s (%s) as malformed', async (amount) => {
      await createFixture();
      await expectQuoteError(createDepositQuote(userId, amount, undefined), 'INVALID_AMOUNT');
    });

    it.each([
      ['9999', 'below the floor'],
      ['50000001', 'above the ceiling']
    ])('rejects amount %s (%s) against the policy bounds', async (amount) => {
      await createFixture();
      // These parse as valid positive integers, so they must fail the POLICY
      // gate rather than the parser — a well-formed amount that is too large.
      await expectQuoteError(createDepositQuote(userId, amount, undefined), 'AMOUNT_OUT_OF_RANGE');
    });

    it('rejects an amount inside the range but outside the policy bounds', async () => {
      await createFixture();
      await setPolicy({ depositMinP: 200000n });

      await expectQuoteError(
        createDepositQuote(userId, '100000', undefined),
        'AMOUNT_OUT_OF_RANGE'
      );
    });

    it('never quotes a non-NGN wallet in kobo', async () => {
      await createFixture('GBP');

      await expectQuoteError(
        createDepositQuote(userId, '100000', undefined),
        'UNSUPPORTED_CURRENCY'
      );
    });

    it('replays a repeated client key instead of issuing a second quote', async () => {
      await createFixture();

      const first = await createDepositQuote(userId, '100000', 'quote_key_abcdef12');
      const second = await createDepositQuote(userId, '999999', 'quote_key_abcdef12');

      expect(second.replayed).toBe(true);
      expect(second.quote.id).toBe(first.quote.id);
      // The replayed amount is the ORIGINAL — a key replay can never re-price.
      expect(second.quote.amountMinorUnits).toBe(100000n);
      expect(await prisma.depositQuote.count({ where: { userId } })).toBe(1);
    });

    it('sets an expiry derived from the configured TTL', async () => {
      await createFixture();
      await setPolicy({ depositQuoteTtlSeconds: 60 });

      const { quote } = await createDepositQuote(userId, '100000', undefined);

      const ttl = quote.expiresAt.getTime() - quote.createdAt.getTime();
      expect(ttl).toBeGreaterThanOrEqual(59_000);
      expect(ttl).toBeLessThanOrEqual(61_000);
    });
  });

  describe('claiming for an intent', () => {
    it('consumes the quote and links it to the created intent', async () => {
      await createFixture();
      const { quote } = await createDepositQuote(userId, '100000', undefined);

      const intent = await createDepositIntent(
        userId,
        100000n,
        'PAYSTACK',
        'u@test.local',
        undefined,
        quote.id
      );

      const stored = await prisma.depositQuote.findUnique({ where: { id: quote.id } });
      expect(stored.status).toBe('CONSUMED');
      expect(stored.consumedByIntentId).toBe(intent.id);
      expect(stored.consumedAt).toBeInstanceOf(Date);
    });

    it('refuses a second intent on the same quote (exactly-once)', async () => {
      await createFixture();
      const { quote } = await createDepositQuote(userId, '100000', undefined);

      await createDepositIntent(userId, 100000n, 'PAYSTACK', 'u@test.local', undefined, quote.id);

      // A replayed checkout with a DIFFERENT client key would otherwise open a
      // second provider checkout for one quote.
      await expectQuoteError(
        createDepositIntent(userId, 100000n, 'PAYSTACK', 'u@test.local', 'second_key_abcdef', quote.id),
        'QUOTE_ALREADY_USED'
      );
      expect(await prisma.depositIntent.count({ where: { userId } })).toBe(1);
    });

    it('refuses an intent whose amount drifted from the quote', async () => {
      await createFixture();
      const { quote } = await createDepositQuote(userId, '100000', undefined);

      // The player saw a fee for ₦1,000 and must not be able to check out ₦9,000
      // against that same quote.
      await expectQuoteError(
        createDepositIntent(userId, 900000n, 'PAYSTACK', 'u@test.local', undefined, quote.id),
        'QUOTE_AMOUNT_MISMATCH'
      );
      // The failed attempt must leave the quote usable.
      const stored = await prisma.depositQuote.findUnique({ where: { id: quote.id } });
      expect(stored.status).toBe('ACTIVE');
    });

    it('refuses a gateway the quote never offered', async () => {
      await createFixture();
      await setPolicy({ flutterwaveEnabled: false });
      const { quote } = await createDepositQuote(userId, '100000', undefined);

      await expectQuoteError(
        createDepositIntent(userId, 100000n, 'FLUTTERWAVE', 'u@test.local', undefined, quote.id),
        'QUOTE_METHOD_UNAVAILABLE'
      );
    });

    it('refuses an expired quote', async () => {
      await createFixture();
      const { quote } = await createDepositQuote(userId, '100000', undefined);
      await prisma.depositQuote.update({
        where: { id: quote.id },
        data: { expiresAt: new Date(Date.now() - 1000) }
      });

      await expectQuoteError(
        createDepositIntent(userId, 100000n, 'PAYSTACK', 'u@test.local', undefined, quote.id),
        'QUOTE_EXPIRED'
      );
    });

    it("refuses another user's quote", async () => {
      await createFixture();
      const { quote } = await createDepositQuote(userId, '100000', undefined);

      const other = await prisma.user.create({
        data: {
          email: `dq-other-${Date.now()}@test.local`,
          passwordHash: 'x',
          wallet: { create: { currency: 'NGN' } }
        }
      });

      await expectQuoteError(
        createDepositIntent(other.id, 100000n, 'PAYSTACK', 'o@test.local', undefined, quote.id),
        'QUOTE_NOT_FOUND'
      );
      await prisma.wallet.deleteMany({ where: { userId: other.id } });
      await prisma.user.delete({ where: { id: other.id } });
    });

    it('still supports a checkout with no quote at all', async () => {
      await createFixture();

      const intent = await createDepositIntent(userId, 100000n, 'PAYSTACK', 'u@test.local');

      expect(intent.reference).toMatch(/^paystack-/);
      expect(intent.amountMinorUnits).toBe(100000n);
    });
  });

  describe('claim gate under concurrency', () => {
    it('lets exactly one of two concurrent claims through', async () => {
      await createFixture();
      const { quote } = await createDepositQuote(userId, '100000', undefined);

      const attempt = () =>
        prisma.$transaction(async (tx) => {
          await claimDepositQuote(tx, {
            userId,
            quoteId: quote.id,
            amountMinorUnits: 100000n,
            gateway: 'PAYSTACK'
          });
        });

      const results = await Promise.allSettled([attempt(), attempt()]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');

      expect(fulfilled).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected');
      expect(rejected.reason.code).toBe('QUOTE_ALREADY_USED');
    });
  });

  describe('expiry sweep', () => {
    it('retires only ACTIVE quotes that are past their TTL', async () => {
      await createFixture();
      const live = await createDepositQuote(userId, '100000', undefined);
      const stale = await createDepositQuote(userId, '200000', undefined);
      await prisma.depositQuote.update({
        where: { id: stale.quote.id },
        data: { expiresAt: new Date(Date.now() - 1000) }
      });

      const count = await expireDepositQuotes();

      expect(count).toBeGreaterThanOrEqual(1);
      expect((await prisma.depositQuote.findUnique({ where: { id: stale.quote.id } })).status)
        .toBe('EXPIRED');
      expect((await prisma.depositQuote.findUnique({ where: { id: live.quote.id } })).status)
        .toBe('ACTIVE');
    });

    it('is idempotent — a second sweep retires nothing extra', async () => {
      await createFixture();
      const { quote } = await createDepositQuote(userId, '100000', undefined);
      await prisma.depositQuote.update({
        where: { id: quote.id },
        data: { expiresAt: new Date(Date.now() - 1000) }
      });

      await expireDepositQuotes();
      const second = await expireDepositQuotes();

      expect(second).toBe(0);
    });
  });

  describe('status lookup', () => {
    it('resolves an intent by its provider reference, not just its id', async () => {
      await createFixture();
      const intent = await createDepositIntent(userId, 100000n, 'PAYSTACK', 'u@test.local');

      // The Flutter client only ever holds the reference.
      const byReference = await getDepositIntent(userId, intent.reference);
      const byId = await getDepositIntent(userId, intent.id);

      expect(byReference.id).toBe(intent.id);
      expect(byId.id).toBe(intent.id);
    });

    it('never leaks another user intent by reference', async () => {
      await createFixture();
      const intent = await createDepositIntent(userId, 100000n, 'PAYSTACK', 'u@test.local');
      const other = await prisma.user.create({
        data: {
          email: `dq-leak-${Date.now()}@test.local`,
          passwordHash: 'x',
          wallet: { create: { currency: 'NGN' } }
        }
      });

      expect(await getDepositIntent(other.id, intent.reference)).toBeNull();
      await prisma.wallet.deleteMany({ where: { userId: other.id } });
      await prisma.user.delete({ where: { id: other.id } });
    });
  });
});
