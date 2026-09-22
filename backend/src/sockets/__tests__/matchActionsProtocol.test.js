import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { createInitialBoard } from '../../modules/engine/index.js';

const mockPrisma = {
  match: {
    findUnique: jest.fn()
  },
  matchReceipt: { findUnique: jest.fn() }
};

jest.unstable_mockModule('../../utils/db.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

class FakeRedis {
  constructor() {
    this.store = new Map();
  }

  exists(key) {
    return this.store.has(key) ? 1 : 0;
  }

  hset(key, obj) {
    const hash = this.store.get(key) || {};
    Object.assign(hash, obj);
    this.store.set(key, hash);
    return 1;
  }

  hgetall(key) {
    return this.store.get(key) ? { ...this.store.get(key) } : {};
  }

  hget(key, field) {
    return this.store.get(key)?.[field] ?? null;
  }

  hdel(key, ...fields) {
    const hash = this.store.get(key);
    if (!hash) return 0;
    for (const f of fields) delete hash[f];
    return 1;
  }

  set(key, value) { this.store.set(key, value); return 'OK'; }
  get(key) { return this.store.get(key) ?? null; }
  del(key) { return this.store.delete(key) ? 1 : 0; }
  expire() { return 1; }
}

const fakeRedis = new FakeRedis();
jest.unstable_mockModule('../../utils/redis.js', () => ({ default: fakeRedis }));

// The live ready/draw transitions route through the socket layer; the durable
// lifecycle CAS is mocked so the tests exercise the projection + emissions.
const mockTransition = jest.fn();
jest.unstable_mockModule('../../modules/match/service.js', () => ({
  transitionMatchWhere: mockTransition,
  isLiveStatus: jest.fn((s) => ['ACTIVE', 'IN_PLAY'].includes(s)),
  transitionMatch: jest.fn()
}));

const settlementMocks = {
  settleGame: jest.fn(),
  settleGameDraw: jest.fn(),
  settleGameWithRetry: jest.fn(),
  settleGameDrawWithRetry: jest.fn()
};
jest.unstable_mockModule('../settlement.js', () => settlementMocks);

const roomEmits = [];
const io = {
  to(room) {
    return {
      emit: (event, payload) => { roomEmits.push({ room, event, payload }); }
    };
  }
};
jest.unstable_mockModule('../index.js', () => ({ getIO: jest.fn(() => io) }));

const {
  handlePlayerReady,
  handleDrawOffer,
  handleDrawRespond,
} = await import('../gameManager.js');
const { buildStatePayload } = await import('../gameProtocol.js');

const emitSince = (room, event) => roomEmits.filter((e) => e.room === room && e.event === event);
const socketFor = (userId) => ({
  user: { userId },
  emit: jest.fn()
});

const seededState = (overrides = {}) => {
  const board = createInitialBoard();
  const hash = JSON.stringify([board, 'WHITE']);
  const base = {
    player1: 'p1',
    player2: 'p2',
    currentTurn: 'WHITE',
    currentTurnUserId: 'p1',
    board: JSON.stringify(board),
    status: 'in_progress',
    winnerId: '',
    stakeTier: 'AMATEUR',
    moveCount: '5',
    version: '5',
    positionCounts: JSON.stringify({ [hash]: 1 }),
    consecutiveKingMoves: '0',
    lastMoveTs: String(Date.now()),
    deadlineAt: String(Date.now() + 60_000),
    timeControlSeconds: '60',
    turnStartedAtServer: String(Date.now()),
    disconnectGraceMs: '45000'
  };
  fakeRedis.hset('match:m1', { ...base, ...overrides });
};

beforeEach(() => {
  jest.clearAllMocks();
  fakeRedis.store.clear();
  roomEmits.length = 0;
  mockTransition.mockResolvedValue(1);
});

describe('player.ready ready gate', () => {
  it('records the first readiness, retains the ready_pending state and broadcasts participants.ready', async () => {
    seededState({ status: 'ready_pending', version: '0', moveCount: '0', currentTurn: 'WHITE', currentTurnUserId: 'p1' });
    mockPrisma.match.findUnique.mockResolvedValue({
      id: 'm1', status: 'FUNDED', playerLightId: 'p1', playerDarkId: 'p2', tier: 'AMATEUR', startedAt: null
    });

    await handlePlayerReady(socketFor('p1'), { matchId: 'm1', actionId: 'ready_00000001' });

    // durable FUNDED -> READY aligns with the socket gate
    expect(mockTransition).toHaveBeenCalledWith(expect.anything(), 'm1', ['FUNDED'], 'READY');
    expect(fakeRedis.hget('match:m1', 'readyLight')).toBeTruthy();
    expect(fakeRedis.hget('match:m1', 'status')).toBe('ready_pending');

    const state = buildStatePayload('m1', fakeRedis.hgetall('match:m1'));
    expect(state.status).toBe('ready_pending');
    expect(state.sideToMove).toBeNull();
    expect(state.participants.find((p) => p.side === 'LIGHT').ready).toBe(true);
    expect(state.participants.find((p) => p.side === 'DARK').ready).toBe(false);

    // no game.started yet — the gate still waits for the second player
    expect(emitSince('match:m1', 'game.started')).toHaveLength(0);
    expect(emitSince('match:m1', 'match.state')).toHaveLength(1);
  });

  it('starts the game when BOTH players are ready and emits game.started exactly once', async () => {
    seededState({ status: 'ready_pending', version: '0', moveCount: '0', currentTurn: 'WHITE', currentTurnUserId: 'p1' });
    const matchRow = { id: 'm1', status: 'READY', playerLightId: 'p1', playerDarkId: 'p2', tier: 'AMATEUR', startedAt: null };
    mockPrisma.match.findUnique.mockResolvedValue(matchRow);

    await handlePlayerReady(socketFor('p1'), { matchId: 'm1', actionId: 'ready_00000002' });
    await handlePlayerReady(socketFor('p2'), { matchId: 'm1', actionId: 'ready_00000003' });

    expect(mockTransition).toHaveBeenCalledWith(expect.anything(), 'm1', ['FUNDED', 'READY'], 'IN_PLAY', expect.objectContaining({ startedAt: expect.any(Date) }));

    const startedEvents = emitSince('match:m1', 'game.started');
    expect(startedEvents).toHaveLength(1);
    const { matchId, stateVersion, startedAt, board, clocks } = startedEvents[0].payload;
    expect(matchId).toBe('m1');
    expect(stateVersion).toBe(0);
    expect(typeof startedAt).toBe('number');
    expect(Array.isArray(board)).toBe(true);
    expect(clocks.deadlineAt).toBeGreaterThan(Date.now() - 60_000);

    const payload = emitSince('match:m1', 'match.state')[1].payload;
    expect(payload.status).toBe('in_progress');
    expect(payload.sideToMove).toMatchObject({ color: 'WHITE', userId: 'p1' });
    expect(payload.participants.every((p) => p.ready)).toBe(true);

    // a third ready (re-ready) never re-emits game.started
    await handlePlayerReady(socketFor('p1'), { matchId: 'm1', actionId: 'ready_00000004' });
    expect(emitSince('match:m1', 'game.started')).toHaveLength(1);
  });

  it('refuses a non-participant', async () => {
    seededState({ status: 'ready_pending' });
    mockPrisma.match.findUnique.mockResolvedValue({
      id: 'm1', status: 'FUNDED', playerLightId: 'p1', playerDarkId: 'p2', tier: 'AMATEUR', startedAt: null
    });
    const socket = socketFor('hacker');
    await handlePlayerReady(socket, { matchId: 'm1', actionId: 'ready_00000005' });
    expect(socket.emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'not_authorized' }));
  });
});

describe('draw.offer', () => {
  it('stores and broadcasts a pending draw offer from the current-turn player', async () => {
    seededState();
    const socket = socketFor('p1');

    await handleDrawOffer(socket, { matchId: 'm1', actionId: 'offer_action_01', expectedStateVersion: 5 });

    const saved = JSON.parse(fakeRedis.hget('match:m1', 'pendingDrawOffer'));
    expect(saved.offeredByUserId).toBe('p1');
    expect(saved.offerId).toMatch(/^draw_offer_/);
    expect(saved.expectedStateVersion).toBe(5);

    const payload = emitSince('match:m1', 'match.state')[0].payload;
    expect(payload.pendingDrawOffer).toMatchObject({ offeredByUserId: 'p1' });
  });

  it('rejects a second offer while one is pending, and rejects a stale version', async () => {
    seededState();
    await handleDrawOffer(socketFor('p1'), { matchId: 'm1', actionId: 'offer_action_02', expectedStateVersion: 5 });

    const second = socketFor('p1');
    await handleDrawOffer(second, { matchId: 'm1', actionId: 'offer_action_03', expectedStateVersion: 5 });
    expect(second.emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'draw_already_offered' }));

    const stale = socketFor('p1');
    await handleDrawOffer(stale, { matchId: 'm1', actionId: 'offer_action_04', expectedStateVersion: 4 });
    expect(stale.emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'stale_state', currentVersion: 5 }));
    // resync pushes the authoritative state to the stale client
    expect(stale.emit).toHaveBeenCalledWith('match.state', expect.objectContaining({ stateVersion: 5 }));
  });

  it('rejects offers from the wrong turn or from outside the match', async () => {
    seededState(); // currentTurnUserId: p1
    const wrongTurn = socketFor('p2');
    await handleDrawOffer(wrongTurn, { matchId: 'm1', actionId: 'offer_action_05' });
    expect(wrongTurn.emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'not_your_turn' }));

    const outsider = socketFor('x');
    await handleDrawOffer(outsider, { matchId: 'm1', actionId: 'offer_action_06' });
    expect(outsider.emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'not_authorized' }));
  });

  it('rejects offers when no live projection exists', async () => {
    // no seeded projection
    const socket = socketFor('p1');
    await handleDrawOffer(socket, { matchId: 'm1', actionId: 'offer_action_07' });
    expect(socket.emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'game_already_ended' }));
  });
});

describe('draw.respond', () => {
  it('accept declines a pending offer, clears it and broadcasts the continuing state', async () => {
    seededState();
    await handleDrawOffer(socketFor('p1'), { matchId: 'm1', actionId: 'offer_action_08' });
    const saved = JSON.parse(fakeRedis.hget('match:m1', 'pendingDrawOffer'));
    roomEmits.length = 0;

    const responder = socketFor('p2');
    await handleDrawRespond(responder, { matchId: 'm1', actionId: 'resp_action_001', offerId: saved.offerId, response: 'decline' });

    expect(settlementMocks.settleGameDrawWithRetry).not.toHaveBeenCalled();
    expect(fakeRedis.hget('match:m1', 'pendingDrawOffer')).toBeNull();
    expect(emitSince('match:m1', 'match.state')[0].payload.pendingDrawOffer).toBeNull();
  });

  it('accept settles a mutual draw through the settlement layer', async () => {
    seededState();
    await handleDrawOffer(socketFor('p1'), { matchId: 'm1', actionId: 'offer_action_09' });
    const saved = JSON.parse(fakeRedis.hget('match:m1', 'pendingDrawOffer'));

    await handleDrawRespond(socketFor('p2'), { matchId: 'm1', actionId: 'resp_action_002', offerId: saved.offerId, response: 'accept' });

    expect(settlementMocks.settleGameDrawWithRetry).toHaveBeenCalledWith('m1', 'mutual_draw');
  });

  it('rejects an unknown offer id, an outsider, and the offerer answering their own offer', async () => {
    seededState();
    await handleDrawOffer(socketFor('p1'), { matchId: 'm1', actionId: 'offer_action_10' });
    const saved = JSON.parse(fakeRedis.hget('match:m1', 'pendingDrawOffer'));

    const unknown = socketFor('p2');
    await handleDrawRespond(unknown, { matchId: 'm1', actionId: 'resp_action_003', offerId: 'draw_offer_does_not_exist', response: 'accept' });
    expect(unknown.emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'draw_offer_not_found' }));

    const own = socketFor('p1');
    await handleDrawRespond(own, { matchId: 'm1', actionId: 'resp_action_004', offerId: saved.offerId, response: 'accept' });
    expect(own.emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'cannot_respond_to_own_offer' }));

    const outsider = socketFor('x');
    await handleDrawRespond(outsider, { matchId: 'm1', actionId: 'resp_action_005', offerId: saved.offerId, response: 'accept' });
    expect(outsider.emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'not_authorized' }));
  });
});

describe('match.state contract shape', () => {
  it('exposes participants, connection and settlementStatus on the canonical payload', async () => {
    seededState({
      status: 'completed',
      winnerId: 'p1',
      readyLight: String(Date.now()),
      readyDark: String(Date.now()),
      connLIGHT: JSON.stringify({ status: 'connected' }),
      connDARK: JSON.stringify({ status: 'disconnected', graceEndsAt: 1_800_000_000_000 }),
      pendingDrawOffer: JSON.stringify({ offerId: 'draw_offer_abc', offeredByUserId: 'p2' })
    });

    const payload = buildStatePayload('m1', fakeRedis.hgetall('match:m1'));
    expect(payload.stateVersion).toBe(5);
    expect(payload.sideToMove).toBeNull(); // completed — no side to move
    expect(payload.participants).toHaveLength(2);
    expect(payload.participants.every((p) => p.ready)).toBe(true);
    expect(payload.connection).toEqual(expect.arrayContaining([
      expect.objectContaining({ side: 'LIGHT', status: 'connected' }),
      expect.objectContaining({ side: 'DARK', status: 'disconnected', graceEndsAt: 1_800_000_000_000 })
    ]));
    expect(payload.pendingDrawOffer).toMatchObject({ offerId: 'draw_offer_abc' });
    expect(payload.settlementStatus).toBe('pending');
  });
});