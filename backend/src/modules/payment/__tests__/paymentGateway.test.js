import { jest } from '@jest/globals';
import { PaystackGateway, mapPaystackTransferStatus } from '../PaystackGateway.js';
import { FlutterwaveGateway, mapFlutterwaveTransferStatus } from '../FlutterwaveGateway.js';
import crypto from 'crypto';

describe('Payment Gateways', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  describe('PaystackGateway', () => {
    let gateway;
    beforeEach(() => {
      process.env.PAYSTACK_SECRET_KEY = 'test_secret_key';
      gateway = new PaystackGateway();
    });

    it('should verify webhook signature correctly', () => {
      const payload = { event: 'charge.success', data: { reference: 'abc' } };
      const rawBody = Buffer.from(JSON.stringify(payload));
      
      const signature = crypto.createHmac('sha512', 'test_secret_key').update(rawBody).digest('hex');
      
      expect(gateway.verifyWebhookSignature(rawBody, signature)).toBe(true);
      expect(gateway.verifyWebhookSignature(rawBody, 'invalid-signature')).toBe(false);
    });

    it('should retry on fetch failure and eventually throw if max retries exceeded', async () => {
      // Mock fetch to always fail
      global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

      const startTime = Date.now();
      await expect(gateway.initiatePayment(5000, 'user123', 'test@test.com'))
        .rejects.toThrow('Payment provider unavailable, try again');
      
      // Should have taken at least 1000ms due to backoff
      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeGreaterThanOrEqual(1000);
      expect(global.fetch).toHaveBeenCalledTimes(2); // Initial + 1 retry
    });

    it('passes the server-created intent reference and exact minor-unit amount to the provider', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: true, data: { authorization_url: 'https://paystack.link/x', reference: 'paystack-intent-ref' } })
      });

      const result = await gateway.initiatePayment(125000, 'user123', 'test@test.com', 'paystack-intent-ref');

      const [, options] = global.fetch.mock.calls[0];
      const body = JSON.parse(options.body);
      // Exact string minor units, never FP math
      expect(body.amount).toBe('125000');
      expect(body.reference).toBe('paystack-intent-ref');
      expect(body.metadata.userId).toBe('user123');
      expect(result.reference).toBe('paystack-intent-ref');
    });

    it('verifyPayoutStatus maps the provider transfer state to a verdict', async () => {
      const providerResponse = {
        ok: true,
        json: async () => ({ status: true, data: { status: 'success', reference: 'wit-1' } })
      };
      global.fetch = jest.fn().mockResolvedValue(providerResponse);

      const verdict = await gateway.verifyPayoutStatus({ reference: 'wit-1', providerRef: null });

      // queries the dedicated transfer-verify endpoint with our reference
      expect(global.fetch.mock.calls[0][0]).toMatch(/\/transfer\/verify\/wit-1$/);
      expect(verdict).toEqual({ status: 'success' });
    });

    it('verifyPayoutStatus surfaces an ambiguous provider state', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: true, data: { status: 'pending' } })
      });

      const verdict = await gateway.verifyPayoutStatus({ reference: 'wit-1' });

      expect(verdict).toEqual({ status: 'processing' });
    });
  });

  describe('mapPaystackTransferStatus', () => {
    it('maps terminal states exactly and everything else to processing', () => {
      expect(mapPaystackTransferStatus('success')).toBe('success');
      expect(mapPaystackTransferStatus('failed')).toBe('failed');
      expect(mapPaystackTransferStatus('reversed')).toBe('failed');
      expect(mapPaystackTransferStatus('pending')).toBe('processing');
      expect(mapPaystackTransferStatus('something-weird')).toBe('processing');
    });
  });

  describe('FlutterwaveGateway', () => {
    let gateway;
    beforeEach(() => {
      process.env.FLUTTERWAVE_SECRET_KEY = 'flw_secret';
      process.env.FLUTTERWAVE_SECRET_HASH = 'flw_hash_123';
      gateway = new FlutterwaveGateway();
    });

    it('should verify webhook signature correctly', () => {
      const rawBody = Buffer.from(JSON.stringify({ event: 'charge.completed' }));
      
      expect(gateway.verifyWebhookSignature(rawBody, 'flw_hash_123')).toBe(true);
      expect(gateway.verifyWebhookSignature(rawBody, 'invalid-signature')).toBe(false);
    });

    it('uses the server-created intent reference as tx_ref and converts minor units exactly to major', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'success', data: { link: 'https://flutterwave.link/x' } })
      });

      const result = await gateway.initiatePayment(125050, 'user123', 'test@test.com', 'flutterwave-intent-ref');

      const [, options] = global.fetch.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.tx_ref).toBe('flutterwave-intent-ref');
      // 125050 minor = 1250.50 major, via integer math (no floats)
      expect(body.amount).toBe('1250.50');
      expect(body.meta.userId).toBe('user123');
      expect(result.reference).toBe('flutterwave-intent-ref');
    });

    it('verifyPayoutStatus looks the transfer up by the provider transfer id', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'success', data: { status: 'SUCCESSFUL' } })
      });

      const verdict = await gateway.verifyPayoutStatus({ reference: 'wit-1', providerRef: 'prov-9' });

      expect(global.fetch.mock.calls[0][0]).toMatch(/\/v3\/transfers\/prov-9$/);
      expect(verdict).toEqual({ status: 'success' });
    });

    it('verifyPayoutStatus refuses to probe without a provider transfer id', async () => {
      global.fetch = jest.fn();
      await expect(gateway.verifyPayoutStatus({ reference: 'wit-1', providerRef: null }))
        .rejects.toThrow(/without its transfer id/i);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('mapFlutterwaveTransferStatus', () => {
    it('maps terminal states exactly and everything else to processing', () => {
      expect(mapFlutterwaveTransferStatus('SUCCESSFUL')).toBe('success');
      expect(mapFlutterwaveTransferStatus('FAILED')).toBe('failed');
      expect(mapFlutterwaveTransferStatus('PENDING')).toBe('processing');
      expect(mapFlutterwaveTransferStatus('queued')).toBe('processing');
    });
  });
});
