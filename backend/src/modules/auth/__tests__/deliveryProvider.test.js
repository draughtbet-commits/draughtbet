import { jest } from '@jest/globals';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.REDIS_URL = '';

const mockRedis = {
  set: jest.fn(),
  get: jest.fn(),
  del: jest.fn()
};

jest.unstable_mockModule('../../../utils/db.js', () => ({
  default: { user: { findUnique: jest.fn() } }
}));
jest.unstable_mockModule('../../../utils/redis.js', () => ({
  default: mockRedis
}));

const { default: logger } = await import('../../../utils/logger.js');
jest.spyOn(logger, 'info').mockImplementation(() => {});
jest.spyOn(logger, 'warn').mockImplementation(() => {});
jest.spyOn(logger, 'error').mockImplementation(() => {});

const {
  getDeliveryProvider,
  resetDeliveryProviderCache,
  OTPDeliveryError,
  HttpEmailProvider,
  MailboxDeliveryProvider,
  DiscardDeliveryProvider,
  FailClosedProvider,
  MAILBOX_MODE,
  EMAIL_MODE
} = await import('../deliveryProvider.js');

const realCode = '482913';
const args = { userId: 'u1', purpose: 'EMAIL_VERIFY', code: realCode, challengeId: 'c1', destination: 'user@x.com' };

beforeEach(() => resetDeliveryProviderCache());

const useFakeFetch = (impl) => {
  global.fetch = jest.fn(impl);
  return () => {
    delete global.fetch;
  };
};

describe('OTP delivery provider selection', () => {
  it('selects discard by default in non-production', () => {
    const provider = getDeliveryProvider({ env: { NODE_ENV: 'test' } });
    expect(provider).toBeInstanceOf(DiscardDeliveryProvider);
  });

  it('selects mailbox when OTP_DELIVERY=mailbox', () => {
    const provider = getDeliveryProvider({ env: { NODE_ENV: 'test', OTP_DELIVERY: MAILBOX_MODE } });
    expect(provider).toBeInstanceOf(MailboxDeliveryProvider);
  });

  it('selects email when OTP_DELIVERY=email', () => {
    const provider = getDeliveryProvider({ env: { NODE_ENV: 'test', OTP_DELIVERY: EMAIL_MODE } });
    expect(provider).toBeInstanceOf(HttpEmailProvider);
  });

  it('treats DEV_OTP_MAILBOX=1 as mailbox in non-production', () => {
    const provider = getDeliveryProvider({ env: { NODE_ENV: 'test', DEV_OTP_MAILBOX: '1' } });
    expect(provider).toBeInstanceOf(MailboxDeliveryProvider);
  });

  it('fails closed in production when OTP_DELIVERY is unset', () => {
    const provider = getDeliveryProvider({ env: { NODE_ENV: 'production' } });
    expect(provider).toBeInstanceOf(FailClosedProvider);
    return expect(provider.deliver({})).rejects.toBeInstanceOf(OTPDeliveryError);
  });
});

describe('DiscardDeliveryProvider', () => {
  it('never throws, never reveals the code', async () => {
    const provider = new DiscardDeliveryProvider();
    await expect(provider.deliver(args)).resolves.toMatchObject({ delivered: false, channel: null });
    const logged = JSON.stringify(logger.info.mock.calls);
    expect(logged).not.toContain(realCode);
  });
});

describe('FailClosedProvider', () => {
  it('throws OTPDeliveryError (503) on any delivery', async () => {
    const provider = new FailClosedProvider();
    await expect(provider.deliver(args)).rejects.toMatchObject({
      name: 'OTPDeliveryError',
      status: 503,
      code: 'OTP_DELIVERY_UNAVAILABLE'
    });
  });
});

describe('HttpEmailProvider', () => {
  it('throws OTP_DELIVERY_UNAVAILABLE when not configured', async () => {
    const provider = new HttpEmailProvider({});
    await expect(provider.deliver(args)).rejects.toMatchObject({
      status: 503,
      code: 'OTP_DELIVERY_UNAVAILABLE'
    });
  });

  it('POSTs the code to the API and never logs it', async () => {
    const restore = useFakeFetch(() => ({ ok: true }));
    const provider = new HttpEmailProvider({
      apiUrl: 'https://email.example.test/emails',
      apiKey: 'key',
      from: 'Draught Bet <no-reply@example.test>'
    });

    try {
      const result = await provider.deliver(args);
      expect(result).toEqual({ delivered: true, channel: 'email' });
      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url, opts] = global.fetch.mock.calls[0];
      expect(url).toBe('https://email.example.test/emails');
      expect(opts.headers.Authorization).toBe('Bearer key');
      const body = JSON.parse(opts.body);
      expect(body.to).toEqual(['user@x.com']);
      expect(body).not.toHaveProperty('email');
      expect(body.text).toContain(realCode);
      expect(JSON.stringify(logger.info.mock.calls)).not.toContain(realCode);
    } finally {
      restore();
    }
  });

  it('throws OTP_DELIVERY_FAILED on API error response', async () => {
    const restore = useFakeFetch(() => ({ ok: false, status: 500, text: async () => 'boom' }));
    const provider = new HttpEmailProvider({
      apiUrl: 'https://email.example.test/emails',
      apiKey: 'key',
      from: 'noreply@example.test'
    });
    try {
      await expect(provider.deliver(args)).rejects.toMatchObject({
        status: 503,
        code: 'OTP_DELIVERY_FAILED'
      });
    } finally {
      restore();
    }
  });

  it('throws OTP_DELIVERY_FAILED on network failure', async () => {
    const restore = useFakeFetch(() => { throw new Error('network down'); });
    const provider = new HttpEmailProvider({
      apiUrl: 'https://email.example.test/emails',
      apiKey: 'key',
      from: 'noreply@example.test'
    });
    try {
      await expect(provider.deliver(args)).rejects.toMatchObject({
        status: 503,
        code: 'OTP_DELIVERY_FAILED'
      });
    } finally {
      restore();
    }
  });
});

describe('MailboxDeliveryProvider', () => {
  it('stashes the code and can read it back', async () => {
    mockRedis.set.mockResolvedValue('OK');
    mockRedis.get.mockResolvedValue(realCode);
    const provider = new MailboxDeliveryProvider();
    const result = await provider.deliver(args);
    expect(result).toMatchObject({ channel: 'mailbox' });
    expect(mockRedis.set).toHaveBeenCalled();
    await expect(provider.readCode('c1')).resolves.toBe(realCode);
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(realCode);
  });
});