import { jest } from '@jest/globals';

const mockPrisma = {
  supportCase: {
    count: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn()
  },
  supportCaseEvent: { create: jest.fn() },
  $transaction: jest.fn()
};

jest.unstable_mockModule('../../../utils/db.js', () => ({
  default: mockPrisma
}));

jest.unstable_mockModule('../../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

const {
  SUPPORT_CASE_TYPES,
  SUPPORT_CASE_STATUSES,
  openSupportCase,
  listMySupportCases,
  resolveOpenAccountCases,
  getMySupportCase,
  closeMySupportCase,
  SupportCaseError,
  SupportCaseNotFoundError,
  SupportCaseOpenLimitError
} = await import('../service.js');

const tx = {
  supportCase: { create: jest.fn(), update: jest.fn(), findMany: jest.fn() },
  supportCaseEvent: { create: jest.fn() }
};

const now = new Date('2026-10-03T10:00:00.000Z');
const caseRow = (over = {}) => ({
  id: 'a04fd9b2-79b',
  userId: 'user-1',
  type: 'ACCOUNT',
  status: 'OPEN',
  subject: 'Account restricted — please review',
  description: null,
  relatedMatchId: null,
  assignedAdminUserId: null,
  createdAt: now,
  updatedAt: now,
  closedAt: null,
  ...over
});

beforeEach(() => {
  jest.resetAllMocks();
  mockPrisma.$transaction.mockImplementation(async (fn) => fn(tx));
  tx.supportCase.create.mockResolvedValue(caseRow());
  tx.supportCaseEvent.create.mockResolvedValue({ id: 'event-1' });
});

describe('support case contract', () => {
  test('exposes ACCOUNT so restricted players can open a case', () => {
    expect(SUPPORT_CASE_TYPES).toContain('ACCOUNT');
  });

  test('statuses match what the app expects to receive', () => {
    // The Flutter client maps these exact wire values; IN_PROGRESS and
    // WAITING_USER in particular previously fell through to "unknown".
    expect(SUPPORT_CASE_STATUSES).toEqual(
      expect.arrayContaining([
        'OPEN',
        'IN_PROGRESS',
        'WAITING_USER',
        'RESOLVED',
        'CLOSED'
      ])
    );
  });
});

describe('openSupportCase', () => {
  test('opens an ACCOUNT case and records the CASE_OPENED event', async () => {
    mockPrisma.supportCase.count.mockResolvedValue(0);

    const view = await openSupportCase('user-1', {
      type: 'ACCOUNT',
      subject: '  Account restricted — please review  ',
      description: '  Cannot deposit or withdraw.  '
    });

    expect(tx.supportCase.create).toHaveBeenCalledTimes(1);
    const data = tx.supportCase.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      userId: 'user-1',
      type: 'ACCOUNT',
      subject: 'Account restricted — please review',
      description: 'Cannot deposit or withdraw.'
    });
    expect(tx.supportCaseEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ eventType: 'CASE_OPENED' })
    });
    expect(view.type).toBe('ACCOUNT');
    expect(view.status).toBe('OPEN');
  });

  test('never projects a full id as a displayable reference', async () => {
    mockPrisma.supportCase.count.mockResolvedValue(0);
    const view = await openSupportCase('user-1', {
      type: 'ACCOUNT',
      subject: 'Restricted'
    });
    // The view returns the raw id; masking is the client's job. Guard that no
    // pre-masked/derived field leaks a second copy.
    expect(Object.keys(view)).not.toContain('reference');
  });

  test('omits an empty description rather than storing whitespace', async () => {
    mockPrisma.supportCase.count.mockResolvedValue(0);
    await openSupportCase('user-1', {
      type: 'ACCOUNT',
      subject: 'Restricted',
      description: '   '
    });
    const data = tx.supportCase.create.mock.calls[0][0].data;
    expect('description' in data).toBe(false);
  });

  test('truncates an oversized description', async () => {
    mockPrisma.supportCase.count.mockResolvedValue(0);
    await openSupportCase('user-1', {
      type: 'ACCOUNT',
      subject: 'Restricted',
      description: 'x'.repeat(5000)
    });
    const data = tx.supportCase.create.mock.calls[0][0].data;
    expect(data.description).toHaveLength(4000);
  });

  test('rejects an unsupported type', async () => {
    await expect(
      openSupportCase('user-1', { type: 'BANANAS', subject: 'hi' })
    ).rejects.toBeInstanceOf(SupportCaseError);
    expect(mockPrisma.supportCase.count).not.toHaveBeenCalled();
  });

  test('rejects a missing or blank subject', async () => {
    for (const subject of [undefined, '', '   ']) {
      await expect(
        openSupportCase('user-1', { type: 'ACCOUNT', subject })
      ).rejects.toBeInstanceOf(SupportCaseError);
    }
  });

  test('rejects a subject over 200 characters', async () => {
    await expect(
      openSupportCase('user-1', { type: 'ACCOUNT', subject: 'y'.repeat(201) })
    ).rejects.toBeInstanceOf(SupportCaseError);
  });

  test('caps concurrent open cases so the queue cannot be flooded', async () => {
    mockPrisma.supportCase.count.mockResolvedValue(4);
    await expect(
      openSupportCase('user-1', { type: 'ACCOUNT', subject: 'Restricted' })
    ).rejects.toBeInstanceOf(SupportCaseOpenLimitError);
    expect(tx.supportCase.create).not.toHaveBeenCalled();
  });
});

describe('resolveOpenAccountCases', () => {
  test('resolves only the open ACCOUNT appeals and records why', async () => {
    mockPrisma.supportCase.findMany.mockResolvedValue([
      { id: 'appeal-1' },
      { id: 'appeal-2' }
    ]);
    mockPrisma.$transaction.mockImplementation((fn) => fn(tx));

    const rows = await resolveOpenAccountCases('user-1', {
      note: 'Account reinstated'
    });

    // Only the player's open ACCOUNT cases: a PAYMENT or KYC thread is a
    // separate conversation and must survive the reinstatement.
    expect(mockPrisma.supportCase.findMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        type: 'ACCOUNT',
        status: { in: ['OPEN', 'IN_PROGRESS', 'WAITING_USER'] }
      },
      select: { id: true }
    });
    expect(tx.supportCase.update).toHaveBeenCalledTimes(2);
    expect(tx.supportCase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'appeal-1' },
        data: expect.objectContaining({ status: 'RESOLVED' })
      })
    );
    expect(tx.supportCaseEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        supportCaseId: 'appeal-2',
        eventType: 'STATUS_CHANGED',
        message: 'Account reinstated'
      })
    });
    expect(rows).toHaveLength(2);
  });

  test('does nothing when the player has no open appeal', async () => {
    mockPrisma.supportCase.findMany.mockResolvedValue([]);

    const rows = await resolveOpenAccountCases('user-1');

    expect(rows).toEqual([]);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('listMySupportCases', () => {
  test('scopes the list to the caller and newest first', async () => {
    mockPrisma.supportCase.findMany.mockResolvedValue([
      caseRow({ id: 'new', subject: 'newest' }),
      caseRow({ id: 'old', subject: 'oldest', status: 'IN_PROGRESS' })
    ]);

    const rows = await listMySupportCases('user-1');

    expect(mockPrisma.supportCase.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      orderBy: { createdAt: 'desc' },
      take: 100
    });
    expect(rows.map((r) => r.id)).toEqual(['new', 'old']);
    expect(rows[1].status).toBe('IN_PROGRESS');
  });
});

describe('getMySupportCase', () => {
  test('returns the caller own case with its event trail', async () => {
    mockPrisma.supportCase.findUnique.mockResolvedValue({
      ...caseRow(),
      events: [{ id: 'e1', eventType: 'CASE_OPENED', message: 'Case opened', createdAt: now }]
    });

    const view = await getMySupportCase('user-1', 'a04fd9b2-79b');

    expect(view.events).toHaveLength(1);
    expect(view.events[0].eventType).toBe('CASE_OPENED');
  });

  test("hides another player's case behind a not-found", async () => {
    mockPrisma.supportCase.findUnique.mockResolvedValue(caseRow({ userId: 'someone-else' }));
    await expect(getMySupportCase('user-1', 'a04fd9b2-79b')).rejects.toBeInstanceOf(
      SupportCaseNotFoundError
    );
  });

  test('is not found when the row does not exist', async () => {
    mockPrisma.supportCase.findUnique.mockResolvedValue(null);
    await expect(getMySupportCase('user-1', 'missing')).rejects.toBeInstanceOf(
      SupportCaseNotFoundError
    );
  });
});

describe('closeMySupportCase', () => {
  test('records the closure on the caller own open case', async () => {
    mockPrisma.supportCase.findUnique.mockResolvedValue(caseRow());
    tx.supportCase.update.mockResolvedValue(caseRow({ status: 'CLOSED' }));

    await closeMySupportCase('user-1', 'a04fd9b2-79b');

    expect(tx.supportCase.update).toHaveBeenCalled();
  });

  test('refuses to close another player case', async () => {
    mockPrisma.supportCase.findUnique.mockResolvedValue(caseRow({ userId: 'someone-else' }));
    await expect(closeMySupportCase('user-1', 'a04fd9b2-79b')).rejects.toBeInstanceOf(
      SupportCaseNotFoundError
    );
    expect(tx.supportCase.update).not.toHaveBeenCalled();
  });
});