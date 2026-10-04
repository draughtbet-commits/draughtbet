import { jest } from '@jest/globals';
import crypto from 'crypto';

const mockPrisma = {
  user: { findUnique: jest.fn(), update: jest.fn() },
  verificationCase: {
    create: jest.fn(),
    update: jest.fn(),
    // The service settles a verdict with a conditional update so two concurrent
    // deliveries cannot both win. Defaults to "matched one row".
    updateMany: jest.fn(async () => ({ count: 1 })),
    findFirst: jest.fn(),
    findMany: jest.fn(async () => []),
    findUnique: jest.fn()
  },
  verificationCheck: { create: jest.fn(), update: jest.fn() },
  verificationWebhookEvent: { create: jest.fn(), updateMany: jest.fn() },
  // The service writes the case, its checks and the player together, so the
  // transaction has to be modelled or nothing here would ever run.
  $transaction: jest.fn(async (fn) => fn(mockPrisma))
};

jest.unstable_mockModule('../../../utils/db.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

const { startVerification, applyVerificationResult } = await import('../service.js');
const {
  DojahKycProvider,
  SimulatedKycProvider,
  createKycProvider,
  mapDojahVerification,
  KycProviderError
} = await import('../providerAdapter.js');
const { makeVerificationDedupeKey } = await import('../webhookController.js');

const SECRET = 'sk_dojah_test_secret';

describe('DojahKycProvider', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      DOJAH_APP_ID: 'app-123',
      DOJAH_SECRET_KEY: SECRET,
      DOJAH_WIDGET_ID: 'widget-abc'
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it('is asynchronous, so a verdict is never returned from start()', () => {
    expect(new DojahKycProvider().mode).toBe('async');
    expect(new SimulatedKycProvider().mode).toBe('sync');
  });

  it('mints an opaque reference and a widget URL without calling Dojah', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const provider = new DojahKycProvider();

    const started = await provider.start('user-1');

    // The provider hosts the capture experience; start is a local operation.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(started.providerReference).toMatch(/^dbt-[0-9a-f]{32}$/);
    // Dojah requires at least 10 characters for a reference_id.
    expect(started.providerReference.length).toBeGreaterThanOrEqual(10);
    expect(started.provider).toBe('dojah');
    expect(started.widgetUrl).toContain('widget_id=widget-abc');
    expect(started.widgetUrl).toContain(`reference_id=${started.providerReference}`);
  });

  it('keeps identifying data out of the reference', async () => {
    const { providerReference, widgetUrl } = await new DojahKycProvider().start(
      'fintechslimited@gmail.com'
    );
    // Dojah echoes the reference into client callbacks, URLs and logs.
    expect(providerReference).not.toContain('@');
    expect(widgetUrl).not.toContain('@');
    expect(providerReference).not.toContain('fintechslimited');
  });

  it('refuses to start without a widget id', async () => {
    process.env.DOJAH_WIDGET_ID = '';
    await expect(new DojahKycProvider().start('u1')).rejects.toThrow(KycProviderError);
  });

  it('accepts a signature computed over the exact raw body', () => {
    const provider = new DojahKycProvider();
    const raw = Buffer.from('{"reference_id":"dbt-abc"}');
    const signature = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
    expect(provider.verifyWebhookSignature(raw, signature)).toBe(true);
  });

  it('rejects a tampered body, a wrong key and a missing signature', () => {
    const provider = new DojahKycProvider();
    const raw = Buffer.from('{"reference_id":"dbt-abc"}');

    const signature = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
    // Same signature, different bytes.
    expect(provider.verifyWebhookSignature(Buffer.from('{"reference_id":"dbt-xyz"}'), signature)).toBe(
      false
    );

    const foreign = crypto.createHmac('sha256', 'other-secret').update(raw).digest('hex');
    expect(provider.verifyWebhookSignature(raw, foreign)).toBe(false);

    expect(provider.verifyWebhookSignature(raw, undefined)).toBe(false);
    expect(provider.verifyWebhookSignature(raw, '')).toBe(false);
    // Wrong length must be rejected, not throw on the comparison.
    expect(provider.verifyWebhookSignature(raw, 'abc')).toBe(false);
  });

  it('fails closed when the secret is not configured', () => {
    process.env.DOJAH_SECRET_KEY = '';
    const raw = Buffer.from('{}');
    const signature = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
    expect(new DojahKycProvider().verifyWebhookSignature(raw, signature)).toBe(false);
  });

  it('polls by reference and treats a missing record as still open', async () => {
    const provider = new DojahKycProvider({ baseUrl: 'https://sandbox.dojah.io' });
    jest.spyOn(global, 'fetch').mockResolvedValue({ status: 404, ok: false, json: async () => ({}) });

    const result = await provider.getResult('dbt-abc');
    // A widget the player has not submitted yet must not read as a failure.
    expect(result.status).toBe('PENDING');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://sandbox.dojah.io/api/v1/kyc/verification?reference_id=dbt-abc',
      expect.objectContaining({
        method: 'GET',
        headers: { AppId: 'app-123', Authorization: SECRET }
      })
    );
  });

  it('surfaces an unreachable provider as a provider error', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(new DojahKycProvider().getResult('dbt-abc')).rejects.toThrow(KycProviderError);
  });
});

describe('mapDojahVerification', () => {
  it('maps a completed verification to PASSED', () => {
    const result = mapDojahVerification({
      status: true,
      reference_id: 'dbt-abc',
      verification_status: 'Completed',
      verification_type: 'RC-NUMBER',
      data: {
        id: { data: {}, status: true },
        selfie: { data: {}, status: true }
      }
    });

    expect(result.status).toBe('PASSED');
    expect(result.providerReference).toBe('dbt-abc');
    expect(result.checks).toEqual(
      expect.arrayContaining([
        { type: 'ID_DOCUMENT', passed: true, message: null },
        { type: 'SELFIE', passed: true, message: null }
      ])
    );
  });

  it('maps a failed verification to FAILED and keeps per-check detail', () => {
    const result = mapDojahVerification({
      status: false,
      reference_id: 'dbt-abc',
      verification_status: 'Failed',
      data: {
        id: { data: {}, status: false, message: 'Blurred image' },
        selfie: { data: {}, status: true }
      }
    });

    expect(result.status).toBe('FAILED');
    const idCheck = result.checks.find((c) => c.type === 'ID_DOCUMENT');
    expect(idCheck.passed).toBe(false);
    expect(idCheck.message).toBe('Blurred image');
  });

  it('treats in-flight and unrecognised states as pending rather than failed', () => {
    expect(
      mapDojahVerification({ verification_status: 'Ongoing', data: {} }).status
    ).toBe('PENDING');
    expect(mapDojahVerification({ verification_status: 'Pending', data: {} }).status).toBe(
      'PENDING'
    );
    // A provider state we have not seen must never reject a player on a guess.
    expect(mapDojahVerification({ verification_status: 'Under Review', data: {} }).status).toBe(
      'PENDING'
    );
    expect(mapDojahVerification({ data: {} }).status).toBe('PENDING');
  });

  it('drops evidence it cannot represent and collapses duplicate check types', () => {
    const result = mapDojahVerification({
      status: true,
      verification_status: 'Completed',
      data: {
        // Government data is the same underlying evidence as the ID capture.
        government_data: { status: false },
        id: { status: false },
        // AML has no VerificationCheckType equivalent.
        aml: { status: false },
        metadata: { status: true }
      }
    });

    const idChecks = result.checks.filter((c) => c.type === 'ID_DOCUMENT');
    expect(idChecks).toHaveLength(1);
    expect(result.checks.map((c) => c.type)).not.toContain('AML');
  });
});

describe('async verification flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', kycStatus: 'NONE' });
    mockPrisma.verificationCase.findFirst.mockResolvedValue(null);
    mockPrisma.verificationCase.create.mockImplementation(async ({ data }) => ({ id: 'case-1', ...data }));
    mockPrisma.verificationCheck.create.mockImplementation(async ({ data }) => ({ id: 'check-1', ...data }));
  });

  it('leaves the case pending and never rejects when the answer is not in yet', async () => {
    const provider = new DojahKycProvider({ widgetId: 'widget-abc' });
    const getResult = jest.spyOn(provider, 'getResult');

    const result = await startVerification('u1', {}, { provider });

    expect(result.status).toBe('PENDING');
    expect(result.providerReference).toMatch(/^dbt-/);
    expect(result.widgetUrl).toContain('reference_id=');
    // The verdict comes later, over a webhook.
    expect(getResult).not.toHaveBeenCalled();
    expect(mockPrisma.verificationCase.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PENDING', providerReference: result.providerReference })
      })
    );
    // The mobile SDK launches by widget id rather than by URL.
    expect(result.widgetId).toBe('widget-abc');
    expect(result.widgetUrl).toContain('reference_id=');
    // Nothing is decided, so nothing about the player changes.
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
    expect(mockPrisma.verificationCase.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'REJECTED' }) })
    );
  });

  it('persists the reference before a result can arrive', async () => {
    const provider = new DojahKycProvider({ widgetId: 'widget-abc' });
    await startVerification('u1', {}, { provider });

    // The webhook knows nothing but the reference, so it must already exist.
    const created = mockPrisma.verificationCase.create.mock.calls[0][0].data;
    expect(created.providerReference).toBeTruthy();
  });
});

describe('applyVerificationResult', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.user.update.mockImplementation(async ({ data }) => ({ id: 'u1', ...data }));
    mockPrisma.verificationCheck.create.mockImplementation(async ({ data }) => ({ id: 'check-2', ...data }));
  });

  it('projects a later verdict onto the case, checks and player', async () => {
    mockPrisma.verificationCase.findUnique.mockResolvedValue({
      id: 'case-1',
      userId: 'u1',
      status: 'PENDING',
      providerReference: 'dbt-abc',
      checks: [{ id: 'check-1', type: 'ID_DOCUMENT' }]
    });

    const caseId = await applyVerificationResult({
      providerReference: 'dbt-abc',
      result: {
        status: 'PASSED',
        checks: [
          { type: 'ID_DOCUMENT', passed: true },
          { type: 'SELFIE', passed: true }
        ]
      }
    });

    expect(caseId).toBe('case-1');
    expect(mockPrisma.verificationCase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'case-1' }),
        data: expect.objectContaining({ status: 'VERIFIED' })
      })
    );
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { kycStatus: 'VERIFIED', ageVerified: true }
    });
    // The selfie was never requested at start, so it is recorded from the result.
    expect(mockPrisma.verificationCheck.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'SELFIE', status: 'PASSED' }) })
    );
  });

  it('records a failure without verifying the player', async () => {
    mockPrisma.verificationCase.findUnique.mockResolvedValue({
      id: 'case-1',
      userId: 'u1',
      status: 'PENDING',
      providerReference: 'dbt-abc',
      checks: [{ id: 'check-1', type: 'ID_DOCUMENT' }]
    });

    await applyVerificationResult({
      providerReference: 'dbt-abc',
      result: { status: 'FAILED', checks: [{ type: 'ID_DOCUMENT', passed: false }] }
    });

    expect(mockPrisma.verificationCase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'case-1' }),
        data: expect.objectContaining({ status: 'REJECTED' })
      })
    );
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('ignores a result for an unknown reference', async () => {
    mockPrisma.verificationCase.findUnique.mockResolvedValue(null);
    const caseId = await applyVerificationResult({
      providerReference: 'dbt-unknown',
      result: { status: 'PASSED' }
    });
    expect(caseId).toBeNull();
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('will not let a late delivery overturn an already-settled case', async () => {
    mockPrisma.verificationCase.findUnique.mockResolvedValue({
      id: 'case-1',
      userId: 'u1',
      status: 'VERIFIED',
      providerReference: 'dbt-abc',
      checks: [{ id: 'check-1', type: 'ID_DOCUMENT', status: 'PASSED' }]
    });

    // A duplicated or out-of-order failure must not revoke a verified player.
    await applyVerificationResult({
      providerReference: 'dbt-abc',
      result: { status: 'FAILED' }
    });

    expect(mockPrisma.verificationCase.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });
});

describe('webhook dedupe', () => {
  it('treats a retried delivery as the same event even if the bytes differ', () => {
    const base = { provider: 'dojah', providerReference: 'dbt-abc' };
    expect(
      makeVerificationDedupeKey({ ...base, eventType: 'verification.completed' })
    ).toBe(
      makeVerificationDedupeKey({
        ...base,
        eventType: 'verification.completed',
        payloadHash: 'reformatted-by-a-retry'
      })
    );
  });

  it('keeps distinct events for the same verification apart', () => {
    const base = { provider: 'dojah', providerReference: 'dbt-abc' };
    expect(makeVerificationDedupeKey({ ...base, eventType: 'a' })).not.toBe(
      makeVerificationDedupeKey({ ...base, eventType: 'b' })
    );
    // A second reference is a different attempt and must not be swallowed.
    expect(makeVerificationDedupeKey({ ...base, eventType: 'a' })).not.toBe(
      makeVerificationDedupeKey({
        provider: 'dojah',
        providerReference: 'dbt-other',
        eventType: 'a'
      })
    );
  });
});

describe('provider selection', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  it('fails closed rather than simulating a check nobody performed', () => {
    delete process.env.KYC_PROVIDER;
    // Falling back to the simulated provider here would approve players and hand
    // out withdrawal rights on a misconfigured deployment.
    expect(() => createKycProvider()).toThrow(KycProviderError);
    expect(() => createKycProvider()).toThrow(/not configured/);
  });

  it('still offers the simulated provider when it is asked for explicitly', () => {
    process.env.KYC_PROVIDER = 'simulated';
    expect(createKycProvider()).toBeInstanceOf(SimulatedKycProvider);
  });

  it('selects Dojah when configured', () => {
    process.env.KYC_PROVIDER = 'dojah';
    expect(createKycProvider()).toBeInstanceOf(DojahKycProvider);
  });

  it('rejects an unknown provider rather than falling back', () => {
    expect(() => createKycProvider('trust-me')).toThrow(KycProviderError);
  });

  it('refuses to verify anyone in production with the simulated provider', () => {
    process.env.NODE_ENV = 'production';
    process.env.KYC_PROVIDER = 'simulated';
    // Simulated approves every applicant; that must not reach production.
    expect(() => createKycProvider()).toThrow(/would approve every applicant/);
  });
});