import { jest } from '@jest/globals';
import express from 'express';
import supertest from 'supertest';
import logger from '../../utils/logger.js';
import { requestIdMiddleware, finalErrorHandler } from '../requestId.js';

jest.spyOn(logger, 'error').mockImplementation(() => {});
jest.spyOn(logger, 'info').mockImplementation(() => {});

const buildApp = () => {
  const app = express();
  app.use(requestIdMiddleware);
  app.get('/ok', (req, res) => res.json({ id: req.id }));
  app.get('/boom', () => {
    throw new Error('boom');
  });
  app.use(finalErrorHandler);
  return app;
};

describe('request ID middleware', () => {
  it('assigns a request ID and exposes it on the response header', async () => {
    const res = await supertest(buildApp()).get('/ok');
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.body.id).toBe(res.headers['x-request-id']);
  });

  it('honours a client-supplied x-request-id when it is short', async () => {
    const res = await supertest(buildApp()).get('/ok').set('x-request-id', 'client-trace-abc');
    expect(res.headers['x-request-id']).toBe('client-trace-abc');
  });

  it('ignores an oversized client-supplied x-request-id', async () => {
    const huge = 'x'.repeat(200);
    const res = await supertest(buildApp()).get('/ok').set('x-request-id', huge);
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.headers['x-request-id']).not.toBe(huge);
  });

  it('includes requestId in the error contract and never leaks stack traces', async () => {
    const res = await supertest(buildApp()).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'Internal Server Error',
      requestId: expect.any(String)
    });
  });
});