import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import crypto from 'crypto';

process.env.PAYSTACK_SECRET_KEY = 'ps_test_secret';
process.env.FLUTTERWAVE_SECRET_HASH = 'flw_test_hash';

const ioMock = { to: jest.fn().mockReturnThis(), emit: jest.fn() };

const mockProcessDepositWebhook = jest.fn();
const mockParseDecimal = jest.fn((v) => {
  const s = String(v);
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  return BigInt(m[1]) * 100n + BigInt((m[2] || '').padEnd(2, '0'));
});

jest.unstable_mockModule('../../wallet/service.js', () => ({
  processDepositWebhook: mockProcessDepositWebhook,
  parseDecimalMajorToMinor: mockParseDecimal,
  parseMinorUnits: jest.fn(),
  parseIdempotencyKey: jest.fn()
}));
jest.unstable_mockModule('../../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));
jest.unstable_mockModule('../webhookEventLog.js', () => ({
  recordWebhookReceived: jest.fn(async (args) => `evt:${args.providerReference || args.providerEventId || 'unknown'}`),
  recordWebhookResult: jest.fn(async () => {})
}));
jest.unstable_mockModule('../../../sockets/index.js', () => ({
  getIO: () => ioMock
}));
jest.unstable_mockModule('../../notification/service.js', () => ({
  NotificationService: { create: jest.fn() }
}));
jest.unstable_mockModule('../PaystackGateway.js', () => ({
  PaystackGateway: class {
    verifyWebhookSignature(raw, sig) {
      const expected = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(raw).digest('hex');
      return sig === expected;
    }
  }
}));
jest.unstable_mockModule('../FlutterwaveGateway.js', () => ({
  FlutterwaveGateway: class {
    verifyWebhookSignature(_raw, sig) {
      return sig === process.env.FLUTTERWAVE_SECRET_HASH;
    }
  }
}));

const express = (await import('express')).default;
const { default: request } = await import('supertest');
const { webhookRouter } = await import('../webhookController.js');
const { recordWebhookReceived, recordWebhookResult } = await import('../webhookEventLog.js');

const app = express();
app.use(webhookRouter);

const paystackSig = (payload) =>
  crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(Buffer.from(JSON.stringify(payload))).digest('hex');

const paystackEvent = (overrides = {}) => ({
  event: 'charge.success',
  data: {
    reference: 'paystack-intent-ref',
    amount: 50000,
    currency: 'NGN',
    metadata: { userId: 'user-1' },
    ...overrides
  }
});

describe('webhookController (S08: credit only from verified stored intents)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ioMock.to.mockReturnThis();
  });

  it('Paystack: a valid, correctly-signed event credits once and acknowledges with 200', async () => {
    mockProcessDepositWebhook.mockResolvedValue({
      handled: true,
      alreadyApplied: false,
      intent: { amountMinorUnits: 50000n, userId: 'user-1' },
      transaction: { walletId: 'w-1', amountMinorUnits: 50000n }
    });

    const res = await request(app)
      .post('/paystack')
      .set('x-paystack-signature', paystackSig(paystackEvent()))
      .send(paystackEvent());

    expect(res.status).toBe(200);
    expect(mockProcessDepositWebhook).toHaveBeenCalledWith({
      reference: 'paystack-intent-ref',
      amountMinorUnits: 50000,
      currency: 'NGN',
      gateway: 'PAYSTACK',
      userId: 'user-1'
    });
    // Socket delivery is durable: enqueued in the credit tx and published by
    // the outbox drainer, so the webhook layer emits nothing.
    expect(ioMock.emit).not.toHaveBeenCalled();
    // Forensic log: one RECEIVED row finalized as PROCESSED.
    expect(recordWebhookReceived).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'PAYSTACK',
        signatureValid: true,
        eventType: 'charge.success'
      })
    );
    expect(recordWebhookResult).toHaveBeenCalledWith({
      provider: 'PAYSTACK',
      dedupeKey: 'evt:paystack-intent-ref',
      processingStatus: 'PROCESSED',
      errorCode: undefined
    });
  });

  it('Paystack: rejects a bad signature with 401 before anything else', async () => {
    const res = await request(app)
      .post('/paystack')
      .set('x-paystack-signature', 'forged')
      .send(paystackEvent());

    expect(res.status).toBe(401);
    expect(mockProcessDepositWebhook).not.toHaveBeenCalled();
    // A forged/bad signature is still forensically recorded as REJECTED.
    expect(recordWebhookReceived).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'PAYSTACK', signatureValid: false })
    );
    expect(recordWebhookResult).toHaveBeenCalledWith(
      expect.objectContaining({ processingStatus: 'REJECTED', errorCode: 'INVALID_SIGNATURE' })
    );
  });

  it('Paystack: a mismatched-amount event is acknowledged with no credit and no emit', async () => {
    mockProcessDepositWebhook.mockResolvedValue({ handled: false, reason: 'AMOUNT_MISMATCH' });

    const res = await request(app)
      .post('/paystack')
      .set('x-paystack-signature', paystackSig(paystackEvent({ amount: 999999 })))
      .send(paystackEvent({ amount: 999999 }));

    expect(res.status).toBe(200);
    expect(ioMock.emit).not.toHaveBeenCalled();
  });

  it('Paystack: a duplicate delivery is acknowledged without re-emitting', async () => {
    mockProcessDepositWebhook.mockResolvedValue({ handled: false, alreadyApplied: true });

    const res = await request(app)
      .post('/paystack')
      .set('x-paystack-signature', paystackSig(paystackEvent()))
      .send(paystackEvent());

    expect(res.status).toBe(200);
    expect(ioMock.emit).not.toHaveBeenCalled();
  });

  it('Paystack: an unknown event type is ignored', async () => {
    const payload = { ...paystackEvent(), event: 'charge.failed' };
    const res = await request(app)
      .post('/paystack')
      .set('x-paystack-signature', paystackSig(payload))
      .send(payload);

    expect(res.status).toBe(200);
    expect(mockProcessDepositWebhook).not.toHaveBeenCalled();
  });

  it('Paystack: missing userId metadata yields 400 before processing', async () => {
    const res = await request(app)
      .post('/paystack')
      .set('x-paystack-signature', paystackSig(paystackEvent({ metadata: {} })))
      .send(paystackEvent({ metadata: {} }));

    expect(res.status).toBe(400);
    expect(mockProcessDepositWebhook).not.toHaveBeenCalled();
  });

  it('Flutterwave: converts major-unit amount exactly and passes the stored tx_ref', async () => {
    mockProcessDepositWebhook.mockResolvedValue({
      handled: true,
      alreadyApplied: false,
      intent: { amountMinorUnits: 125050n, userId: 'user-1' },
      transaction: { walletId: 'w-1', amountMinorUnits: 125050n }
    });

    const payload = {
      event: 'charge.completed',
      data: {
        tx_ref: 'flutterwave-intent-ref',
        amount: '1250.50',
        currency: 'NGN',
        status: 'successful',
        meta: { userId: 'user-1' }
      }
    };

    const res = await request(app)
      .post('/flutterwave')
      .set('verif-hash', process.env.FLUTTERWAVE_SECRET_HASH)
      .send(payload);

    expect(res.status).toBe(200);
    expect(mockProcessDepositWebhook).toHaveBeenCalledWith({
      reference: 'flutterwave-intent-ref',
      amountMinorUnits: 125050n,
      currency: 'NGN',
      gateway: 'FLUTTERWAVE',
      userId: 'user-1'
    });
  });

  it('Flutterwave: an unsigned event is rejected with 401', async () => {
    const res = await request(app)
      .post('/flutterwave')
      .set('verif-hash', 'wrong')
      .send({ event: 'charge.completed', data: {} });

    expect(res.status).toBe(401);
    expect(mockProcessDepositWebhook).not.toHaveBeenCalled();
  });

  it('Flutterwave: a non-successful charge is ignored', async () => {
    const payload = {
      event: 'charge.completed',
      data: { tx_ref: 'x', amount: '1.00', currency: 'NGN', status: 'failed', meta: { userId: 'user-1' } }
    };
    const res = await request(app)
      .post('/flutterwave')
      .set('verif-hash', process.env.FLUTTERWAVE_SECRET_HASH)
      .send(payload);

    expect(res.status).toBe(200);
    expect(mockProcessDepositWebhook).not.toHaveBeenCalled();
  });
});