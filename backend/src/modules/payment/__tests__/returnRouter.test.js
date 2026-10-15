import { jest, describe, it, expect } from '@jest/globals';

const express = (await import('express')).default;
const { default: request } = await import('supertest');
const { paymentsRouter } = await import('../returnRouter.js');

const app = express();
app.use('/api/v1/payments', paymentsRouter);

describe('payments return page', () => {
  it('serves an HTML page that bounces to the app scheme', async () => {
    const res = await request(app).get('/api/v1/payments/return');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    // meta refresh + manual link both hand off to the app
    expect(res.text).toContain('draughts://app/payment/callback');
  });

  it('makes no success claim — the server status is authoritative', async () => {
    const res = await request(app).get('/api/v1/payments/return');

    expect(res.text.toLowerCase()).not.toContain('payment successful');
    expect(res.text.toLowerCase()).toContain('server confirms');
  });
});
