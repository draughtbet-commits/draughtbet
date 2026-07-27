import { jest } from '@jest/globals';
import { PaystackGateway } from '../PaystackGateway.js';
import { FlutterwaveGateway } from '../FlutterwaveGateway.js';
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
  });
});
