import { jest } from '@jest/globals';

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../../utils/logger.js', () => ({ default: mockLogger }));

const {
  isEmailConfigured,
  deliverEmail,
  sendEmail,
  EmailDeliveryError
} = await import('../emailService.js');

const CONFIG = {
  env: {
    EMAIL_API_URL: 'https://api.example.test/emails',
    EMAIL_API_KEY: 'key-123',
    EMAIL_FROM: 'Draught Bet <no-reply@draughtbet.com>'
  }
};

describe('emailService', () => {
  const okResponse = { ok: true, text: async () => '' };
  const failResponse = { ok: false, status: 422, text: async () => 'bad' };

  beforeEach(() => jest.clearAllMocks());

  describe('isEmailConfigured', () => {
    it('is false without full config', () => {
      expect(isEmailConfigured({ env: {} })).toBe(false);
      expect(isEmailConfigured({ env: { EMAIL_API_URL: 'x' } })).toBe(false);
    });

    it('is true with url + key + from', () => {
      expect(isEmailConfigured(CONFIG)).toBe(true);
    });
  });

  describe('deliverEmail', () => {
    it('posts the provider payload and returns delivered', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(okResponse);
      const result = await deliverEmail(
        { to: 'a@b.com', subject: 'Hi', text: 'body', html: '<p>body</p>' },
        { ...CONFIG, fetchImpl }
      );

      expect(result).toEqual({ delivered: true, channel: 'email' });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchImpl.mock.calls[0];
      expect(url).toBe('https://api.example.test/emails');
      expect(opts.method).toBe('POST');
      expect(opts.headers.Authorization).toBe('Bearer key-123');
      expect(JSON.parse(opts.body)).toMatchObject({
        from: 'Draught Bet <no-reply@draughtbet.com>',
        to: ['a@b.com'],
        subject: 'Hi',
        text: 'body',
        html: '<p>body</p>'
      });
    });

    it('throws EmailDeliveryError when unconfigured', async () => {
      await expect(
        deliverEmail({ to: 'a@b.com', subject: 'x' }, { env: {} })
      ).rejects.toBeInstanceOf(EmailDeliveryError);
    });

    it('throws when the provider rejects the message', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(failResponse);
      await expect(
        deliverEmail({ to: 'a@b.com', subject: 'x' }, { ...CONFIG, fetchImpl })
      ).rejects.toBeInstanceOf(EmailDeliveryError);
    });

    it('throws when the network call rejects', async () => {
      const fetchImpl = jest.fn().mockRejectedValue(new Error('boom'));
      await expect(
        deliverEmail({ to: 'a@b.com', subject: 'x' }, { ...CONFIG, fetchImpl })
      ).rejects.toBeInstanceOf(EmailDeliveryError);
    });
  });

  describe('sendEmail (best-effort)', () => {
    it('skips without config and never throws', async () => {
      const result = await sendEmail({ to: 'a@b.com', subject: 'x' }, { env: {} });
      expect(result).toEqual({ delivered: false, skipped: true });
    });

    it('skips when there is no recipient', async () => {
      const fetchImpl = jest.fn();
      const result = await sendEmail({ subject: 'x' }, { ...CONFIG, fetchImpl });
      expect(result).toEqual({ delivered: false, skipped: true });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('reports delivered on success', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(okResponse);
      const result = await sendEmail({ to: 'a@b.com', subject: 'x' }, { ...CONFIG, fetchImpl });
      expect(result).toEqual({ delivered: true, skipped: false });
    });

    it('swallows a provider failure and returns delivered:false', async () => {
      const fetchImpl = jest.fn().mockRejectedValue(new Error('down'));
      const result = await sendEmail({ to: 'a@b.com', subject: 'x' }, { ...CONFIG, fetchImpl });
      expect(result.delivered).toBe(false);
      expect(result.skipped).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
