import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import crypto from 'node:crypto';
import express from 'express';
import supertest from 'supertest';

process.env.NODE_ENV = 'test';
process.env.PAYSTACK_SECRET_KEY = 'ps_live_test_secret_12345';
process.env.FLUTTERWAVE_SECRET_HASH = 'flw_live_test_hash_67890';

const mockProcessDepositWebhook = jest.fn();
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

jest.unstable_mockModule('../../wallet/service.js', () => ({
  processDepositWebhook: mockProcessDepositWebhook,
  parseDecimalMajorToMinor: jest.fn((v) => BigInt(Math.round(Number(v) * 100))),
  parseMinorUnits: jest.fn(),
  parseIdempotencyKey: jest.fn()
}));
jest.unstable_mockModule('../../../utils/logger.js', () => ({
  default: mockLogger
}));
jest.unstable_mockModule('../../../utils/redis.js', () => ({
  default: null,
  isRedisReady: () => false
}));

const { PaystackGateway } = await import('../PaystackGateway.js');
const { FlutterwaveGateway } = await import('../FlutterwaveGateway.js');
const { webhookRouter } = await import('../webhookController.js');
const { webhookRateLimiter, resetWebhookAuthAbuse } = await import('../../../middleware/rateLimit.js');

const signPaystack = (payload) =>
  crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
    .update(Buffer.from(JSON.stringify(payload)))
    .digest('hex');

describe('Webhook Rate Limiting, Abuse Throttling & Constant-Time Auth', () => {
  const savedLimit = process.env.WEBHOOK_RATE_LIMIT_MAX;
  const savedBadSigLimit = process.env.WEBHOOK_INVALID_SIG_MAX;

  beforeEach(async () => {
    jest.clearAllMocks();
    await resetWebhookAuthAbuse();
    delete process.env.WEBHOOK_RATE_LIMIT_MAX;
    delete process.env.WEBHOOK_INVALID_SIG_MAX;
  });

  afterEach(() => {
    if (savedLimit === undefined) delete process.env.WEBHOOK_RATE_LIMIT_MAX;
    else process.env.WEBHOOK_RATE_LIMIT_MAX = savedLimit;
    if (savedBadSigLimit === undefined) delete process.env.WEBHOOK_INVALID_SIG_MAX;
    else process.env.WEBHOOK_INVALID_SIG_MAX = savedBadSigLimit;
  });

  it('uses timing-safe verification rejecting missing, wrong-length, or tampered signatures', () => {
    const ps = new PaystackGateway();
    const flw = new FlutterwaveGateway();
    const body = Buffer.from(JSON.stringify({ event: 'charge.success', data: {} }));
    const validSig = crypto
      .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
      .update(body)
      .digest('hex');

    expect(ps.verifyWebhookSignature(body, validSig)).toBe(true);
    expect(ps.verifyWebhookSignature(body, undefined)).toBe(false);
    expect(ps.verifyWebhookSignature(body, 'short')).toBe(false);
    expect(ps.verifyWebhookSignature(body, `${validSig.slice(0, -1)}0`)).toBe(false);

    expect(flw.verifyWebhookSignature(body, process.env.FLUTTERWAVE_SECRET_HASH)).toBe(true);
    expect(flw.verifyWebhookSignature(body, null)).toBe(false);
    expect(flw.verifyWebhookSignature(body, 'wrong')).toBe(false);
  });

  it('throttles repeated invalid-signature abuse with 429 while allowing legitimate signed retries', async () => {
    process.env.WEBHOOK_INVALID_SIG_MAX = '3';
    const app = express();
    app.use('/webhooks', webhookRouter);

    const validPayload = {
      event: 'charge.success',
      data: { reference: 'ref-retry-1', amount: 50000, currency: 'NGN', metadata: { userId: 'u1' } }
    };
    mockProcessDepositWebhook.mockResolvedValue({ handled: false, alreadyApplied: true });

    // Legitimate signed provider retries succeed repeatedly without tripping abuse lock
    for (let i = 0; i < 5; i += 1) {
      const okRes = await supertest(app)
        .post('/webhooks/paystack')
        .set('x-paystack-signature', signPaystack(validPayload))
        .send(validPayload);
      expect(okRes.status).toBe(200);
    }

    // Now simulate forged-signature flood from an attacker
    const r1 = await supertest(app)
      .post('/webhooks/paystack')
      .set('x-paystack-signature', 'bad-sig-1')
      .send(validPayload);
    const r2 = await supertest(app)
      .post('/webhooks/paystack')
      .set('x-paystack-signature', 'bad-sig-2')
      .send(validPayload);
    const r3 = await supertest(app)
      .post('/webhooks/paystack')
      .set('x-paystack-signature', 'bad-sig-3')
      .send(validPayload);

    expect(r1.status).toBe(401);
    expect(r2.status).toBe(401);
    expect(r3.status).toBe(429);
    expect(r3.headers['retry-after']).toBe('60');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'webhook_invalid_signature_throttled', provider: 'paystack' }),
      expect.any(String)
    );
  });

  it('enforces webhookRateLimiter ceiling with 429, Retry-After, and structured logging', async () => {
    process.env.WEBHOOK_RATE_LIMIT_MAX = '2';
    const app = express();
    app.use('/webhooks', webhookRateLimiter, webhookRouter);

    const payload = { event: 'unknown.event', data: {} };
    const sig = signPaystack(payload);

    expect(
      (await supertest(app).post('/webhooks/paystack').set('x-paystack-signature', sig).send(payload))
        .status
    ).toBe(200);
    expect(
      (await supertest(app).post('/webhooks/paystack').set('x-paystack-signature', sig).send(payload))
        .status
    ).toBe(200);

    const throttled = await supertest(app)
      .post('/webhooks/paystack')
      .set('x-paystack-signature', sig)
      .send(payload);
    expect(throttled.status).toBe(429);
    expect(throttled.headers['retry-after']).toBeDefined();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'webhook_rate_limited' }),
      expect.any(String)
    );
  });

  it('returns 400 on malformed JSON or missing data object instead of 500', async () => {
    const app = express();
    app.use('/webhooks', webhookRouter);

    const rawInvalid = '{not valid json';
    const validSigForBadJson = crypto
      .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
      .update(Buffer.from(rawInvalid, 'utf8'))
      .digest('hex');

    const badJsonRes = await supertest(app)
      .post('/webhooks/paystack')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', validSigForBadJson)
      .send(rawInvalid);
    expect(badJsonRes.status).toBe(400);

    const missingDataPayload = { event: 'charge.success' };
    const missingDataRes = await supertest(app)
      .post('/webhooks/paystack')
      .set('x-paystack-signature', signPaystack(missingDataPayload))
      .send(missingDataPayload);
    expect(missingDataRes.status).toBe(400);
  });
});
