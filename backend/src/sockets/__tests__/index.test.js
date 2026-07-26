import { jest } from '@jest/globals';

const mockSocket = {
  id: 'socket-id',
  user: { userId: 'user-123' },
  join: jest.fn(),
  on: jest.fn()
};

let connectionCallback;

jest.unstable_mockModule('socket.io', () => {
  return {
    Server: jest.fn().mockImplementation(() => {
      return {
        use: jest.fn(),
        on: jest.fn((event, cb) => {
          if (event === 'connection') {
            connectionCallback = cb;
          }
        })
      };
    })
  };
});

describe('Socket Server Initialization', () => {
  let initSocketServer;

  beforeAll(async () => {
    // Dynamic import AFTER mock
    const mod = await import('../index.js');
    initSocketServer = mod.initSocketServer;
    
    // Mock logger inside beforeAll so it doesn't conflict with ESM loading
    const loggerMod = await import('../../utils/logger.js');
    jest.spyOn(loggerMod.default, 'info').mockImplementation(() => {});
    jest.spyOn(loggerMod.default, 'error').mockImplementation(() => {});
    jest.spyOn(loggerMod.default, 'warn').mockImplementation(() => {});
  });

  beforeEach(() => {
    process.env.ADMIN_CORS_ORIGIN = 'http://localhost';
    process.env.NODE_ENV = 'test';
    jest.clearAllMocks();
  });

  it('should join the personal user:{userId} room upon connection', () => {
    initSocketServer({});
    
    expect(connectionCallback).toBeDefined();
    
    // Trigger connection
    connectionCallback(mockSocket);
    
    // Verify room join
    expect(mockSocket.join).toHaveBeenCalledWith('user:user-123');
    
    // Verify disconnect handler was bound
    expect(mockSocket.on).toHaveBeenCalledWith('disconnect', expect.any(Function));
  });
});
