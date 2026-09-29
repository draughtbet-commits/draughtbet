import { jest } from '@jest/globals';

const mockPrisma = { wallet: {}, idempotencyRecord: { findUnique: jest.fn() } };
const WithdrawalServiceMock = class {
  requestWithdrawal() {
    throw new Error('the legacy withdrawal-request route must not reach the service');
  }
};
class BankAccountNotFoundError extends Error {}

jest.unstable_mockModule('../../../utils/db.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));
jest.unstable_mockModule('../../withdrawal/service.js', () => ({
  WithdrawalService: WithdrawalServiceMock,
  BankAccountNotFoundError,
  toPlayerBankAccount: (b) => ({ id: b.id, maskedAccountNumber: b.maskedAccountNumber ?? null })
}));

const { default: express } = await import('express');
const { default: request } = await import('supertest');
const { walletRouter } = await import('../controller.js');

const app = express();
app.use(express.json());
app.use('/api/v1/wallet', walletRouter);

describe('legacy POST /wallet/withdrawal-request is gone', () => {
  it('no longer exists, so money can only leave via contract §6', async () => {
    const res = await request(app)
      .post('/api/v1/wallet/withdrawal-request')
      .send({ amountMinorUnits: 8000, idempotencyKey: 'legacy-key-1' });

    // 404 from the router, not 403/500 and above all not a successful withdrawal.
    expect(res.status).toBe(404);
  });

  it('never reaches the withdrawal service', async () => {
    const spy = jest.spyOn(WithdrawalServiceMock.prototype, 'requestWithdrawal');
    await request(app)
      .post('/api/v1/wallet/withdrawal-request')
      .send({ amountMinorUnits: 8000, idempotencyKey: 'legacy-key-2' });
    expect(spy).not.toHaveBeenCalled();
  });
});
