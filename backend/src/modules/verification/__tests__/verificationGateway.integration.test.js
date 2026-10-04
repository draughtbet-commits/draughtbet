// Real-PostgreSQL integration test for the KYC verdict path.
//
// The mocked unit suites cannot see the failures that matter most here: a Prisma
// call that is invalid against the real schema throws at runtime, a unique
// index that does not exist is invisible, and a conditional update that silently
// matches nothing looks exactly like one that worked. All three shipped broken
// while every mocked test stayed green.
//
//   DATABASE_URL=postgresql://draughts_arena@127.0.0.1:5544/draughts_arena_test?schema=public \
//   REDIS_URL= RUN_DB_INTEGRATION=1 node --experimental-vm-modules node_modules/jest/bin/jest.js \
//     src/modules/verification/__tests__/verificationGateway.integration.test.js
import crypto from 'crypto';
import prisma from '../../../utils/db.js';
import {
  applyVerificationResult,
  startVerification,
  expireStaleVerificationCases,
  getKycStatus
} from '../service.js';

const describeIntegration =
  process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;

/// A provider that answers on a webhook, like the real one.
const asyncProvider = (widgetId = 'widget-test') => ({
  mode: 'async',
  async start() {
    return {
      providerReference: `dbt-${crypto.randomUUID().replace(/-/g, '')}`,
      provider: 'dojah',
      widgetId,
      widgetUrl: `https://identity.dojah.io/?widget_id=${widgetId}`
    };
  },
  async getResult() {
    return { status: 'PENDING', checks: [] };
  }
});

const makeUser = async (tag) =>
  prisma.user.create({
    data: {
      email: `kyc-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      passwordHash: 'x',
      kycStatus: 'NONE'
    },
    select: { id: true, email: true }
  });

const casesFor = (userId) =>
  prisma.verificationCase.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });

describeIntegration('verification gateway (real PostgreSQL)', () => {
  const created = { users: [], cases: [] };

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: created.users } } });
    await prisma.$disconnect();
  });

  const track = (userId) => {
    created.users.push(userId);
    return userId;
  };

  describe('settling a verdict from the provider reference', () => {
    it('finds the case by providerReference and verifies the player', async () => {
      const user = await makeUser('pass');
      track(user.id);

      const started = await startVerification(user.id, { providerName: 'test' }, {
        dbp: prisma,
        provider: asyncProvider()
      });
      expect(started.status).toBe('PENDING');

      // The lookup the webhook performs. Against a non-unique column this threw
      // PrismaClientValidationError and every real delivery 500'd.
      const caseId = await applyVerificationResult({
        providerReference: started.providerReference,
        result: {
          status: 'PASSED',
          providerReference: started.providerReference,
          checks: [
            { type: 'ID_DOCUMENT', passed: true },
            { type: 'SELFIE', passed: true }
          ]
        }
      });

      expect(caseId).toBe(started.caseId);
      const stored = await prisma.verificationCase.findUnique({
        where: { id: started.caseId },
        include: { checks: true }
      });
      expect(stored.status).toBe('VERIFIED');

      // The money path reads kycStatus, so it must move with the case.
      const verifiedUser = await prisma.user.findUnique({ where: { id: user.id } });
      expect(verifiedUser.kycStatus).toBe('VERIFIED');
      expect(verifiedUser.ageVerified).toBe(true);

      const passed = stored.checks.filter((c) => c.status === 'PASSED').map((c) => c.type);
      expect(passed).toEqual(expect.arrayContaining(['ID_DOCUMENT', 'SELFIE']));
    });

    it('records a rejection without touching kycStatus', async () => {
      const user = await makeUser('fail');
      track(user.id);
      const started = await startVerification(user.id, { providerName: 'test' }, {
        dbp: prisma,
        provider: asyncProvider()
      });

      await applyVerificationResult({
        providerReference: started.providerReference,
        result: { status: 'FAILED', checks: [{ type: 'ID_DOCUMENT', passed: false }] }
      });

      const stored = await prisma.verificationCase.findUnique({ where: { id: started.caseId } });
      expect(stored.status).toBe('REJECTED');
      // A rejection must not imply the user was ever verified.
      const fresh = await prisma.user.findUnique({ where: { id: user.id } });
      expect(fresh.kycStatus).toBe('NONE');
    });

    it('refuses one provider reference being claimed by two cases', async () => {
      // The database-level guarantee behind "one reference, one attempt".
      const user = await makeUser('dupref');
      track(user.id);
      const a = await startVerification(user.id, { providerName: 'test' }, {
        dbp: prisma,
        provider: asyncProvider()
      });
      const other = await makeUser('dupref2');
      track(other.id);

      await expect(
        prisma.verificationCase.create({
          data: {
            userId: other.id,
            status: 'PENDING',
            providerReference: a.providerReference
          }
        })
      ).rejects.toThrow();
    });
  });

  describe('concurrency', () => {
    it('lets exactly one of two simultaneous verdicts settle the case', async () => {
      const user = await makeUser('race');
      track(user.id);
      const started = await startVerification(user.id, { providerName: 'test' }, {
        dbp: prisma,
        provider: asyncProvider()
      });

      // Two different payloads for the same attempt: a pass and a fail landing
      // together. Exactly one may win, and the loser's write must not land.
      const results = await Promise.all([
        applyVerificationResult({
          providerReference: started.providerReference,
          result: { status: 'PASSED', checks: [] }
        }),
        applyVerificationResult({
          providerReference: started.providerReference,
          result: { status: 'FAILED', checks: [] }
        })
      ]);
      expect(results.every((r) => r === started.caseId)).toBe(true);

      const stored = await prisma.verificationCase.findUnique({
        where: { id: started.caseId },
        include: { checks: true }
      });
      // Whichever won, the case and the player's status must agree.
      const fresh = await prisma.user.findUnique({ where: { id: user.id } });
      if (stored.status === 'VERIFIED') {
        expect(fresh.kycStatus).toBe('VERIFIED');
        expect(stored.checks.every((c) => c.status === 'PASSED')).toBe(true);
      } else {
        expect(stored.status).toBe('REJECTED');
        expect(fresh.kycStatus).toBe('NONE');
        expect(stored.checks.every((c) => c.status === 'FAILED')).toBe(true);
      }
    });

    it('applies a re-delivered verdict idempotently', async () => {
      const user = await makeUser('replay');
      track(user.id);
      const started = await startVerification(user.id, { providerName: 'test' }, {
        dbp: prisma,
        provider: asyncProvider()
      });
      const verdict = {
        providerReference: started.providerReference,
        result: { status: 'PASSED', checks: [{ type: 'ID_DOCUMENT', passed: true }] }
      };

      await applyVerificationResult(verdict);
      await applyVerificationResult(verdict);
      await applyVerificationResult(verdict);

      // No duplicate check rows, and the verdict did not move.
      const stored = await prisma.verificationCase.findUnique({
        where: { id: started.caseId },
        include: { checks: true }
      });
      expect(stored.checks).toHaveLength(1);
      expect(stored.status).toBe('VERIFIED');
    });

    it('will not let a late failure overturn a verified case', async () => {
      const user = await makeUser('sticky');
      track(user.id);
      const started = await startVerification(user.id, { providerName: 'test' }, {
        dbp: prisma,
        provider: asyncProvider()
      });
      await applyVerificationResult({
        providerReference: started.providerReference,
        result: { status: 'PASSED', checks: [] }
      });
      await applyVerificationResult({
        providerReference: started.providerReference,
        result: { status: 'FAILED', checks: [] }
      });

      const stored = await prisma.verificationCase.findUnique({ where: { id: started.caseId } });
      const fresh = await prisma.user.findUnique({ where: { id: user.id } });
      expect(stored.status).toBe('VERIFIED');
      expect(fresh.kycStatus).toBe('VERIFIED');
    });
  });

  describe('starting an attempt', () => {
    it('creates only one live case when two requests race', async () => {
      const user = await makeUser('doublestart');
      track(user.id);
      const provider = asyncProvider();

      const settled = await Promise.allSettled([
        startVerification(user.id, { providerName: 'test' }, { dbp: prisma, provider }),
        startVerification(user.id, { providerName: 'test' }, { dbp: prisma, provider })
      ]);
      const fulfilled = settled.filter((s) => s.status === 'fulfilled');
      expect(fulfilled).toHaveLength(1);

      const live = await prisma.verificationCase.findMany({
        where: { userId: user.id, status: { in: ['STARTED', 'PENDING', 'UNDER_REVIEW'] } }
      });
      expect(live).toHaveLength(1);
    });

    it('refuses a provider result check type the schema cannot store', async () => {
      const user = await makeUser('badtype');
      track(user.id);
      const started = await startVerification(user.id, { providerName: 'test' }, {
        dbp: prisma,
        provider: asyncProvider()
      });

      // An out-of-enum type must be dropped, not abort the whole verdict.
      await expect(
        applyVerificationResult({
          providerReference: started.providerReference,
          result: {
            status: 'PASSED',
            checks: [{ type: 'AML_WATCHLIST', passed: false }, { type: 'SELFIE', passed: true }]
          }
        })
      ).resolves.toBe(started.caseId);

      const stored = await prisma.verificationCase.findUnique({
        where: { id: started.caseId },
        include: { checks: true }
      });
      expect(stored.status).toBe('VERIFIED');
      expect(stored.checks.map((c) => c.type)).not.toContain('AML_WATCHLIST');
      expect(stored.checks.map((c) => c.type)).toContain('SELFIE');
    });

    it('fails closed when no provider is configured', async () => {
      const user = await makeUser('noprovider');
      track(user.id);
      const previous = process.env.KYC_PROVIDER;
      delete process.env.KYC_PROVIDER;
      try {
        await expect(
          startVerification(user.id, { providerName: undefined }, { dbp: prisma })
        ).rejects.toThrow(/not configured/);
      } finally {
        if (previous !== undefined) process.env.KYC_PROVIDER = previous;
      }
      // Nothing may have been created on the way to failing.
      expect(await casesFor(user.id)).toHaveLength(0);
    });
  });

  describe('recovering an attempt the provider never answered', () => {
    it('expires a stale pending case so the player is not locked out', async () => {
      const user = await makeUser('stale');
      track(user.id);
      const started = await startVerification(user.id, { providerName: 'test' }, {
        dbp: prisma,
        provider: asyncProvider()
      });

      // Before expiry the player is still blocked, as they should be.
      await expect(
        startVerification(user.id, { providerName: 'test' }, { dbp: prisma, provider: asyncProvider() })
      ).rejects.toThrow(/already/i);

      // Wind the clock past the TTL.
      await prisma.verificationCase.update({
        where: { id: started.caseId },
        data: { expiresAt: new Date(Date.now() - 1000) }
      });

      const { expired } = await expireStaleVerificationCases({ dbp: prisma });
      expect(expired).toBeGreaterThanOrEqual(1);
      const stale = await prisma.verificationCase.findUnique({ where: { id: started.caseId } });
      expect(stale.status).toBe('EXPIRED');

      // And now a fresh attempt is allowed, which is the whole point.
      await expect(
        startVerification(user.id, { providerName: 'test' }, { dbp: prisma, provider: asyncProvider() })
      ).resolves.toMatchObject({ status: 'PENDING' });
    });

    it('never expires a case a verdict already settled', async () => {
      const user = await makeUser('notexpired');
      track(user.id);
      const started = await startVerification(user.id, { providerName: 'test' }, {
        dbp: prisma,
        provider: asyncProvider()
      });
      await applyVerificationResult({
        providerReference: started.providerReference,
        result: { status: 'PASSED', checks: [] }
      });
      await prisma.verificationCase.update({
        where: { id: started.caseId },
        data: { expiresAt: new Date(Date.now() - 1000) }
      });

      await expireStaleVerificationCases({ dbp: prisma });
      const settled = await prisma.verificationCase.findUnique({ where: { id: started.caseId } });
      expect(settled.status).toBe('VERIFIED');
    });

    it('does not verify anyone when it expires an attempt', async () => {
      // The sweep must never be able to grant a verification on its own. The
      // simulated provider answers PASSED to any reference, so if the sweep ever
      // polled one, this assertion is the difference between "no withdrawal" and
      // "withdrawal granted to a player nobody checked".
      const user = await makeUser('noauto');
      track(user.id);
      const stale = await prisma.verificationCase.create({
        data: {
          userId: user.id,
          status: 'PENDING',
          provider: 'simulated',
          providerReference: `sim-${crypto.randomUUID().slice(0, 8)}`,
          expiresAt: new Date(Date.now() - 1000)
        }
      });

      await expireStaleVerificationCases({ dbp: prisma });

      const after = await prisma.verificationCase.findUnique({ where: { id: stale.id } });
      expect(after.status).toBe('EXPIRED');
      const fresh = await prisma.user.findUnique({ where: { id: user.id } });
      expect(fresh.kycStatus).not.toBe('VERIFIED');
    });

    it('keeps a verdict the provider did return, instead of expiring it away', async () => {
      // Polling has to happen before the case is retired, or a provider that
      // answered inside the TTL is discarded and the player is told to retry.
      const user = await makeUser('inwindow');
      track(user.id);
      const started = await startVerification(user.id, { providerName: 'test' }, {
        dbp: prisma,
        provider: asyncProvider()
      });
      await prisma.verificationCase.update({
        where: { id: started.caseId },
        data: { expiresAt: new Date(Date.now() - 1000) }
      });

      const answering = {
        mode: 'async',
        async getResult() {
          return { status: 'PASSED', checks: [{ type: 'SELFIE', passed: true }] };
        }
      };

      const { recovered } = await expireStaleVerificationCases({
        dbp: prisma,
        providerFactory: () => answering
      });
      expect(recovered).toBeGreaterThanOrEqual(1);
      const after = await prisma.verificationCase.findUnique({ where: { id: started.caseId } });
      expect(after.status).toBe('VERIFIED');
      const fresh = await prisma.user.findUnique({ where: { id: user.id } });
      expect(fresh.kycStatus).toBe('VERIFIED');
    });
  });

  describe('status reporting', () => {
    it('reports a standing verification over a stale later attempt', async () => {
      const user = await makeUser('standing');
      track(user.id);
      // Verified directly, then an older-style pending case exists alongside.
      await prisma.user.update({ where: { id: user.id }, data: { kycStatus: 'VERIFIED' } });
      const pending = await prisma.verificationCase.create({
        data: { userId: user.id, status: 'PENDING', provider: 'dojah' }
      });
      // Touched more recently than any other row.
      await prisma.verificationCase.update({
        where: { id: pending.id },
        data: { updatedAt: new Date() }
      });

      const view = await getKycStatus(user.id);
      // The money path honours the verification, so that is what is reported.
      expect(view.kycStatus).toBe('VERIFIED');
      expect(view.case.status).toBe('VERIFIED');
    });
  });
});