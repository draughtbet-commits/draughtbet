import { jest, describe, it, expect, beforeAll, afterAll } from '@jest/globals';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test_secret';
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';

import http from 'node:http';
import { io as ioClient } from 'socket.io-client';
import jwt from 'jsonwebtoken';

describe('socket event rejection safety (real server)', () => {
  let server;
  let port;

  beforeAll(async () => {
    const { initSocketServer } = await import('../index.js');
    server = http.createServer();
    initSocketServer(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const connect = () =>
    ioClient(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      reconnection: false,
      auth: { token: jwt.sign({ userId: 'socket-test-user' }, 'test_secret', { expiresIn: '1m' }) }
    });

  const onceEvent = (socket, event) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), 2000);
      socket.on(event, (data) => {
        clearTimeout(timer);
        resolve(data);
      });
    });

  const connectClient = async (socket) => {
    await new Promise((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('connect_error', reject);
    });
  };

  it('replies a controlled rejection to a null move payload instead of crashing', async () => {
    const socket = connect();
    try {
      const received = onceEvent(socket, 'move_rejected');
      await connectClient(socket);
      socket.emit('move_attempt', null);
      expect(await received).toEqual({ reason: 'invalid_payload' });
    } finally {
      socket.close();
    }
  });

  it('replies controlled rejections to a null resign and join_match payload', async () => {
    const socket = connect();
    try {
      await connectClient(socket);
      socket.emit('resign', null);
      expect((await onceEvent(socket, 'error')).message).toBe('Invalid payload');
      socket.emit('join_match', null);
      expect((await onceEvent(socket, 'error')).message).toBe('Invalid payload');
    } finally {
      socket.close();
    }
  });

  it('handles a valid join_match whose backend write fails with a controlled reply', async () => {
    const socket = connect();
    try {
      const received = onceEvent(socket, 'error');
      await connectClient(socket);
      // Valid payload shape, but Redis is unconfigured in this test env, so the
      // handler throws. The handler's own guard must contain the failure and
      // reply with a controlled error instead of crashing the process.
      socket.emit('join_match', { matchId: '00000000-0000-0000-0000-000000000000' });
      expect((await received).message).toBe('Failed to join match');
    } finally {
      socket.close();
    }
  });

  it('contains an unexpected handler rejection via the shared guard and emits a controlled error', async () => {
    const { guardSocketHandler } = await import('../index.js');
    const socket = { id: 'fake-socket', emit: jest.fn() };
    const throwingHandler = async () => {
      throw new Error('unexpected boom');
    };
    await guardSocketHandler(socket, throwingHandler)({ matchId: 'x' });
    expect(socket.emit).toHaveBeenCalledWith('error', { message: 'Internal server error' });
  });
});