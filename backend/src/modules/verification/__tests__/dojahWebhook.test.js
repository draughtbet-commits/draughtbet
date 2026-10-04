import { jest } from '@jest/globals';
import crypto from 'crypto';

process.env.DOJAH_APP_ID = 'app-123';
process.env.DOJAH_SECRET_KEY = 'dojah_test_secret';

const mockPrisma = {
  verificationWebhookEvent: { create: jest.fn(), updateMany: jest.fn() }
};
const mockApplyVerificationResult = jest.fn();

jest.unstable_mockModule('../../../utils/db.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));
jest.unstable_mockModule('../service.js', () => ({
  applyVerificationResult: mockApplyVerificationResult
}));

const express = (await import('express')).default;
const { default: request } = await import('supertest');
const { verificationWebhookRouter } = await import('../webhookController.js');

const app = express();
app.use('/webhooks', verificationWebhookRouter);

const signatureFor = (payload) =>
  crypto
    .createHmac('sha256', process.env.DOJAH_SECRET_KEY)
    .update(Buffer.from(JSON.stringify(payload)))
    .digest('hex');

const completedEvent = (overrides = {}) => ({
  event: 'verification.completed',
  reference_id: 'dbt-abc',
  verification_status: 'Completed',
  status: true,
  verification_type: 'RC-NUMBER',
  id_type: 'BVN',
  data: { id: { status: true }, selfie: { status: true } },
  ...overrides
});

const post = (payload, { signature } = {}) => {
  const req = request(app).post('/webhooks/dojah');
  if (signature !== null) req.set('x-dojah-signature', signature ?? signatureFor(payload));
  return req.send(payload);
};

describe('Dojah webhook endpoint', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.verificationWebhookEvent.create.mockResolvedValue({ id: 'evt-1' });
    mockPrisma.verificationWebhookEvent.updateMany.mockResolvedValue({ count: 1 });
    mockApplyVerificationResult.mockResolvedValue('case-1');
  });

  it('applies a correctly-signed verification and acknowledges with 200', async () => {
    const payload = completedEvent();

    const res = await post(payload);

    expect(res.status).toBe(200);
    expect(mockApplyVerificationResult).toHaveBeenCalledWith({
      providerReference: 'dbt-abc',
      result: expect.objectContaining({ status: 'PASSED' })
    });
    const stored = mockPrisma.verificationWebhookEvent.create.mock.calls[0][0].data;
    expect(stored).toMatchObject({
      provider: 'dojah',
      providerReference: 'dbt-abc',
      signatureValid: true,
      processingStatus: 'RECEIVED'
    });
    expect(mockPrisma.verificationWebhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ processingStatus: 'PROCESSED' }) })
    );
  });

  it('rejects an invalid signature without writing anything', async () => {
    const res = await post(completedEvent(), { signature: 'deadbeef' });

    expect(res.status).toBe(401);
    // Nothing may be applied on an unauthenticated delivery.
    expect(mockApplyVerificationResult).not.toHaveBeenCalled();
    // And nothing is persisted either. An endpoint anyone can reach would
    // otherwise let an unauthenticated caller grow this table without limit.
    expect(mockPrisma.verificationWebhookEvent.create).not.toHaveBeenCalled();
  });

  it('refuses a delivery that is not a raw signed body', async () => {
    // Malformed requests used to reach the hasher and crash with a 500, which
    // is both a free error and a signal that the route is reachable.
    const res = await request(app)
      .post('/webhooks/dojah')
      .set('content-type', 'application/json')
      .set('x-dojah-signature', 'deadbeef')
      .send('{"broken');

    expect(res.status).toBe(400);
    expect(mockPrisma.verificationWebhookEvent.create).not.toHaveBeenCalled();
  });

  it('refuses a delivery whose reference is missing or the wrong shape', async () => {
    const noRef = await post(completedEvent({ reference_id: undefined }));
    expect(noRef.status).toBe(400);

    const emptyRef = await post(completedEvent({ reference_id: '' }));
    expect(emptyRef.status).toBe(400);

    const longRef = await post(completedEvent({ reference_id: 'x'.repeat(500) }));
    expect(longRef.status).toBe(400);

    // None of them may be applied, however well signed they are.
    expect(mockApplyVerificationResult).not.toHaveBeenCalled();
  });

  it('rejects a body signed with a different secret', async () => {
    const payload = completedEvent();
    const foreign = crypto.createHmac('sha256', 'not-the-secret').update(JSON.stringify(payload)).digest('hex');

    const res = await post(payload, { signature: foreign });

    expect(res.status).toBe(401);
    expect(mockApplyVerificationResult).not.toHaveBeenCalled();
  });

  it('rejects a delivery with no signature header', async () => {
    const res = await post(completedEvent(), { signature: null });

    expect(res.status).toBe(401);
    expect(mockApplyVerificationResult).not.toHaveBeenCalled();
  });

  it('rejects a tampered body carrying a valid signature for other bytes', async () => {
    const res = await post(
      { ...completedEvent(), verification_status: 'Failed', status: false },
      { signature: signatureFor(completedEvent()) }
    );

    expect(res.status).toBe(401);
    expect(mockApplyVerificationResult).not.toHaveBeenCalled();
  });

  it('acknowledges a retried delivery and re-applies it', async () => {
    const uniqueViolation = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    mockPrisma.verificationWebhookEvent.create.mockRejectedValue(uniqueViolation);

    const res = await post(completedEvent());

    // A non-2xx would make Dojah retry forever, so a duplicate is still a 200.
    expect(res.status).toBe(200);
    // Re-applying is deliberate. Skipping on duplicate meant that a delivery
    // which failed with a 500 after the row was written was remembered as done
    // and never processed again -- the player's verdict was lost permanently.
    // Settling a verdict twice is a no-op at the data layer; losing it is not.
    expect(mockApplyVerificationResult).toHaveBeenCalled();
  });

  it('does not downgrade an in-flight verification', async () => {
    const res = await post(completedEvent({ verification_status: 'Ongoing', status: false }));

    expect(res.status).toBe(200);
    expect(mockApplyVerificationResult).not.toHaveBeenCalled();
    expect(mockPrisma.verificationWebhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ processingStatus: 'PROCESSED' }) })
    );
  });

  it('acknowledges a reference it does not recognise', async () => {
    mockApplyVerificationResult.mockResolvedValue(null);

    const res = await post(completedEvent());

    expect(res.status).toBe(200);
    expect(mockPrisma.verificationWebhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ errorCode: 'UNKNOWN_REFERENCE' })
      })
    );
  });

  it('asks the provider to retry when applying the result fails', async () => {
    mockApplyVerificationResult.mockRejectedValue(new Error('db down'));

    const res = await post(completedEvent());

    // A 5xx is what makes Dojah resend; a 200 here would drop the verdict.
    expect(res.status).toBe(500);
    expect(mockPrisma.verificationWebhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ processingStatus: 'FAILED', errorCode: 'APPLY_FAILED' })
      })
    );
  });

  it('rejects a payload with no reference to match', async () => {
    const payload = completedEvent();
    delete payload.reference_id;

    const res = await post(payload);

    expect(res.status).toBe(400);
    expect(mockApplyVerificationResult).not.toHaveBeenCalled();
  });

  it('rejects a body that is not valid JSON', async () => {
    const body = 'not-json';
    const signature = crypto
      .createHmac('sha256', process.env.DOJAH_SECRET_KEY)
      .update(body)
      .digest('hex');

    const res = await request(app)
      .post('/webhooks/dojah')
      .set('Content-Type', 'application/json')
      .set('x-dojah-signature', signature)
      .send(body);

    expect(res.status).toBe(400);
    expect(mockApplyVerificationResult).not.toHaveBeenCalled();
  });
});