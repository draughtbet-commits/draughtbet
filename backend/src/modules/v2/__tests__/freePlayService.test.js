import { jest } from '@jest/globals';

// Free play is a solo game against the server bot. The match is a normal Match
// row, but it must never involve money, rating, or another human: these tests
// pin the seat assignment, the zero stake, and the unrated flag.

const matchCreate = jest.fn();
const platformSettingsFindUnique = jest.fn();
const rulesetVersionFindFirst = jest.fn();
const configVersionFindFirst = jest.fn();

const mockPrisma = {
  match: { create: matchCreate },
  platformSettings: { findUnique: platformSettingsFindUnique },
  rulesetVersion: { findFirst: rulesetVersionFindFirst },
  platformConfigVersion: { findFirst: configVersionFindFirst }
};

jest.unstable_mockModule('../../../utils/db.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

const {
  createFreePlayMatch,
  freePlaySnapshot,
  botIdForMatch,
  isBotId,
  isFreePlayMatch,
  InvalidFreePlayRequestError,
  FREE_PLAY_MODE,
  MIN_FREE_PLAY_TIME_CONTROL_SECONDS,
  MAX_FREE_PLAY_TIME_CONTROL_SECONDS
} = await import('../freePlayService.js');

// The match create echoes back the data it was given, with an id assigned.
const echoCreate = (data) => {
  matchCreate.mockImplementation(async ({ data: createData }) => ({
    ...createData,
    id: createData.id
  }));
};

describe('createFreePlayMatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    platformSettingsFindUnique.mockResolvedValue({ timeControlSeconds: 60 });
    rulesetVersionFindFirst.mockResolvedValue({ id: 'ruleset-1' });
    configVersionFindFirst.mockResolvedValue({ id: 'config-1' });
    echoCreate();
  });

  it('seats the human on the chosen side and the bot on the other', async () => {
    const asLight = await createFreePlayMatch({ userId: 'human-1', side: 'LIGHT', botLevel: 2 });
    expect(asLight.match.playerLightId).toBe('human-1');
    expect(asLight.match.playerDarkId).toBe(`bot:${asLight.match.id}`);
    expect(asLight.humanSide).toBe('LIGHT');

    const asDark = await createFreePlayMatch({ userId: 'human-1', side: 'DARK', botLevel: 2 });
    expect(asDark.match.playerLightId).toBe(`bot:${asDark.match.id}`);
    expect(asDark.match.playerDarkId).toBe('human-1');
    expect(asDark.humanSide).toBe('DARK');
  });

  it('writes an unrated, zero-stake, bot-marked IN_PLAY match', async () => {
    const created = await createFreePlayMatch({ userId: 'human-1', side: 'LIGHT', botLevel: 3 });
    const data = matchCreate.mock.calls[0][0].data;

    expect(data.mode).toBe(FREE_PLAY_MODE);
    expect(data.status).toBe('IN_PLAY');
    expect(data.rated).toBe(false);
    expect(data.stakeMinorUnits).toBe(0n);
    expect(data.settlementCommissionPercent).toBeNull();
    expect(data.botLevel).toBe(3);
    expect(data.botPlayerId).toBe(`bot:${data.id}`);
    expect(data.startedAt).toBeInstanceOf(Date);
    expect(data.rulesetDefId).toBe('ruleset-1');
    expect(data.configVersionId).toBe('config-1');
    expect(created.match.botPlayerId).toBe(botIdForMatch(created.match.id));
  });

  it('records only the human as a participant', async () => {
    await createFreePlayMatch({ userId: 'human-1', side: 'DARK', botLevel: 1 });
    const data = matchCreate.mock.calls[0][0].data;
    expect(data.participants.create).toEqual([{ userId: 'human-1', side: 'DARK' }]);
  });

  it('clamps an out-of-range bot level instead of failing', async () => {
    const tooHigh = await createFreePlayMatch({ userId: 'human-1', side: 'LIGHT', botLevel: 99 });
    expect(tooHigh.level).toBe(4);
    const tooLow = await createFreePlayMatch({ userId: 'human-1', side: 'LIGHT', botLevel: 0 });
    expect(tooLow.level).toBe(1);
  });

  it('clamps the requested clock into the allowed window', async () => {
    const tiny = await createFreePlayMatch({ userId: 'human-1', side: 'LIGHT', timeControlSeconds: 1 });
    expect(tiny.timeControlSeconds).toBe(MIN_FREE_PLAY_TIME_CONTROL_SECONDS);
    const huge = await createFreePlayMatch({ userId: 'human-1', side: 'LIGHT', timeControlSeconds: 100000 });
    expect(huge.timeControlSeconds).toBe(MAX_FREE_PLAY_TIME_CONTROL_SECONDS);
  });

  it('falls back to the platform clock when none is requested', async () => {
    platformSettingsFindUnique.mockResolvedValue({ timeControlSeconds: 45 });
    const created = await createFreePlayMatch({ userId: 'human-1', side: 'LIGHT' });
    expect(created.timeControlSeconds).toBe(45);
  });

  it('rejects an unknown side and a missing user', async () => {
    await expect(createFreePlayMatch({ userId: 'human-1', side: 'SIDEWAYS' }))
      .rejects.toThrow(InvalidFreePlayRequestError);
    await expect(createFreePlayMatch({ userId: null, side: 'LIGHT' }))
      .rejects.toThrow(InvalidFreePlayRequestError);
  });

  it('accepts WHITE/BLACK as aliases for LIGHT/DARK', async () => {
    const created = await createFreePlayMatch({ userId: 'human-1', side: 'WHITE' });
    expect(created.humanSide).toBe('LIGHT');
  });
});

describe('free-play helpers', () => {
  it('recognizes bot ids and free-play matches', () => {
    expect(isBotId(botIdForMatch('abc'))).toBe(true);
    expect(isBotId('human-1')).toBe(false);
    expect(isFreePlayMatch({ mode: FREE_PLAY_MODE })).toBe(true);
    expect(isFreePlayMatch({ mode: 'RANKED' })).toBe(false);
    expect(isFreePlayMatch(null)).toBe(false);
  });

  it('reports a client-safe snapshot', () => {
    const snapshot = freePlaySnapshot({
      match: { id: 'm1', botPlayerId: 'bot:m1' },
      humanSide: 'DARK',
      level: 2,
      timeControlSeconds: 60
    });
    expect(snapshot).toEqual({
      matchId: 'm1',
      mode: FREE_PLAY_MODE,
      side: 'DARK',
      botLevel: 2,
      botId: 'bot:m1',
      timeControlSeconds: 60,
      stakeMinorUnits: 0,
      rated: false
    });
  });
});
