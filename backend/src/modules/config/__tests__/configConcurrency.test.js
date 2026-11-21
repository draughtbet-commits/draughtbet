import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import {
  ConfigService,
  ConfigConflictError,
  ChecksumIntegrityError,
  MakerCheckerViolationError
} from '../service.js';
import { DEFAULT_CONFIG_PAYLOAD } from '../schema.js';
import { generateChecksum } from '../canonicalJson.js';

describe('ConfigService — Activation TOCTOU & Concurrency Controls (Issue #9)', () => {
  const payloadA = structuredClone(DEFAULT_CONFIG_PAYLOAD);
  payloadA.financial.commissionPercent = 12;
  const checksumA = generateChecksum(payloadA);

  const payloadB = structuredClone(DEFAULT_CONFIG_PAYLOAD);
  payloadB.financial.commissionPercent = 15;
  const checksumB = generateChecksum(payloadB);

  let rows;
  let lockQueue;
  let mockDb;

  const createStatefulMockDb = () => {
    rows = new Map();
    lockQueue = Promise.resolve();
    const queryRawCalls = [];

    const db = {
      _queryRawCalls: queryRawCalls,
      $queryRaw: jest.fn(async (strings, ...values) => {
        const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
        queryRawCalls.push({ sql, values });
        if (sql.includes('nextval')) {
          return [{ next_version: rows.size + 1 }];
        }
        return [{ locked: 1 }];
      }),
      // Simulates serialized PostgreSQL advisory lock acquisition per transaction
      $transaction: jest.fn(async (cb) => {
        let release;
        const prev = lockQueue;
        lockQueue = new Promise((r) => {
          release = r;
        });
        await prev;
        try {
          return await cb(db);
        } finally {
          release();
        }
      }),
      platformConfigVersion: {
        findUnique: jest.fn(async ({ where }) => {
          if (where.id) return rows.get(where.id) ? structuredClone(rows.get(where.id)) : null;
          for (const r of rows.values()) {
            if (r.version === where.version) return structuredClone(r);
          }
          return null;
        }),
        findFirst: jest.fn(async ({ where } = {}) => {
          const all = [...rows.values()];
          const filtered = where?.status ? all.filter((r) => r.status === where.status) : all;
          filtered.sort((a, b) => b.version - a.version);
          return filtered[0] ? structuredClone(filtered[0]) : null;
        }),
        create: jest.fn(async ({ data }) => {
          const id = `cfg-v${data.version}`;
          const row = { id, approvals: [], ...data };
          rows.set(id, row);
          return structuredClone(row);
        }),
        updateMany: jest.fn(async ({ where, data }) => {
          let count = 0;
          for (const [id, r] of rows.entries()) {
            if (where.status && r.status !== where.status) continue;
            rows.set(id, { ...r, ...data });
            count += 1;
          }
          return { count };
        }),
        update: jest.fn(async ({ where, data }) => {
          const current = rows.get(where.id);
          if (!current) {
            const err = new Error('Record not found');
            err.code = 'P2025';
            throw err;
          }
          if (where.status && current.status !== where.status) {
            const err = new Error('Record condition failed');
            err.code = 'P2025';
            throw err;
          }
          if (where.checksum && current.checksum !== where.checksum) {
            const err = new Error('Checksum condition failed');
            err.code = 'P2025';
            throw err;
          }
          const updated = { ...current, ...data };
          rows.set(where.id, updated);
          return structuredClone(updated);
        })
      },
      configApproval: {
        create: jest.fn(async ({ data }) => {
          const row = rows.get(data.versionId);
          const approval = { id: `appr-${Date.now()}`, ...data };
          if (row) row.approvals = [...(row.approvals || []), approval];
          return approval;
        })
      },
      platformSettings: {
        upsert: jest.fn().mockResolvedValue({ id: 'singleton' })
      },
      outboxEvent: {
        create: jest.fn().mockResolvedValue({ id: 'outbox-1' })
      },
      adminAuditLog: {
        create: jest.fn().mockResolvedValue({ id: 'audit-1' })
      }
    };
    return db;
  };

  beforeEach(() => {
    mockDb = createStatefulMockDb();
    rows.set('cfg-v1', {
      id: 'cfg-v1',
      version: 1,
      status: 'ACTIVE',
      checksum: generateChecksum(DEFAULT_CONFIG_PAYLOAD),
      payload: structuredClone(DEFAULT_CONFIG_PAYLOAD),
      authorId: 'admin-0',
      isRestricted: false,
      modifiedDomains: [],
      approvals: []
    });
    rows.set('cfg-v2', {
      id: 'cfg-v2',
      version: 2,
      status: 'APPROVED',
      checksum: checksumA,
      payload: structuredClone(payloadA),
      authorId: 'maker-1',
      isRestricted: true,
      modifiedDomains: ['FINANCIAL'],
      approvals: [
        { id: 'appr-v2', status: 'APPROVED', checksum: checksumA, reviewerId: 'checker-1' }
      ]
    });
    rows.set('cfg-v3', {
      id: 'cfg-v3',
      version: 3,
      status: 'APPROVED',
      checksum: checksumB,
      payload: structuredClone(payloadB),
      authorId: 'maker-2',
      isRestricted: true,
      modifiedDomains: ['FINANCIAL'],
      approvals: [
        { id: 'appr-v3', status: 'APPROVED', checksum: checksumB, reviewerId: 'checker-2' }
      ]
    });
  });

  it('acquires PostgreSQL advisory lock + FOR UPDATE row lock inside transaction before reading state', async () => {
    const activated = await ConfigService.activateVersion({
      versionId: 'cfg-v2',
      activatorId: 'super-1',
      expectedVersion: 2,
      expectedChecksum: checksumA,
      dbp: mockDb
    });

    expect(activated.status).toBe('ACTIVE');
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
    expect(mockDb._queryRawCalls[0].sql).toContain('pg_advisory_xact_lock');
    expect(mockDb._queryRawCalls[1].sql).toContain('FOR UPDATE');
    expect(rows.get('cfg-v1').status).toBe('SUPERSEDED');
    expect(rows.get('cfg-v2').status).toBe('ACTIVE');
  });

  it('rejects activation when expectedVersion or expectedChecksum does not match locked DB row', async () => {
    await expect(
      ConfigService.activateVersion({
        versionId: 'cfg-v2',
        activatorId: 'super-1',
        expectedVersion: 99,
        dbp: mockDb
      })
    ).rejects.toThrow(ConfigConflictError);

    await expect(
      ConfigService.activateVersion({
        versionId: 'cfg-v2',
        activatorId: 'super-1',
        expectedChecksum: '0'.repeat(64),
        dbp: mockDb
      })
    ).rejects.toThrow(ChecksumIntegrityError);

    // Original active v1 remains untouched
    expect(rows.get('cfg-v1').status).toBe('ACTIVE');
    expect(rows.get('cfg-v2').status).toBe('APPROVED');
  });

  it('enforces Maker-Checker independence and rejects tampered/rejected approvals at activation time', async () => {
    // Tamper approval so reviewer === author
    rows.get('cfg-v2').approvals = [
      { id: 'appr-self', status: 'APPROVED', checksum: checksumA, reviewerId: 'maker-1' }
    ];
    await expect(
      ConfigService.activateVersion({ versionId: 'cfg-v2', activatorId: 'super-1', dbp: mockDb })
    ).rejects.toThrow(MakerCheckerViolationError);

    // Add a REJECTED review record -> activation must fail
    rows.get('cfg-v2').approvals = [
      { id: 'appr-ok', status: 'APPROVED', checksum: checksumA, reviewerId: 'checker-1' },
      { id: 'appr-rej', status: 'REJECTED', checksum: checksumA, reviewerId: 'checker-2' }
    ];
    await expect(
      ConfigService.activateVersion({ versionId: 'cfg-v2', activatorId: 'super-1', dbp: mockDb })
    ).rejects.toThrow(ConfigConflictError);
  });

  it('prevents conflicting concurrent activations of the same version and guarantees strictly one ACTIVE row', async () => {
    // Two admins simultaneously attempt to activate cfg-v2 -> exactly one wins, second gets ConfigConflictError
    const [r1, r2] = await Promise.allSettled([
      ConfigService.activateVersion({ versionId: 'cfg-v2', activatorId: 'super-1', dbp: mockDb }),
      ConfigService.activateVersion({ versionId: 'cfg-v2', activatorId: 'super-2', dbp: mockDb })
    ]);

    const fulfilled = [r1, r2].filter((r) => r.status === 'fulfilled');
    const rejected = [r1, r2].filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConfigConflictError);

    const activeRows = [...rows.values()].filter((r) => r.status === 'ACTIVE');
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0].id).toBe('cfg-v2');
  });

  it('serializes concurrent activations of two different approved versions so strictly one remains ACTIVE', async () => {
    const [r1, r2] = await Promise.all([
      ConfigService.activateVersion({ versionId: 'cfg-v2', activatorId: 'super-1', dbp: mockDb }),
      ConfigService.activateVersion({ versionId: 'cfg-v3', activatorId: 'super-2', dbp: mockDb })
    ]);

    expect(r1.version).toBe(2);
    expect(r2.version).toBe(3);

    const activeRows = [...rows.values()].filter((r) => r.status === 'ACTIVE');
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0].id).toBe('cfg-v3');
    expect(rows.get('cfg-v2').status).toBe('SUPERSEDED');
    expect(rows.get('cfg-v1').status).toBe('SUPERSEDED');
  });

  it('rollback creates a new sequential DRAFT version and NEVER mutates historical versions', async () => {
    const v1Snapshot = structuredClone(rows.get('cfg-v1'));
    const rollbackDraft = await ConfigService.rollbackVersion({
      targetVersionNumber: 1,
      actorId: 'super-1',
      reason: 'Revert commission rate to baseline v1',
      dbp: mockDb
    });

    expect(rollbackDraft.version).toBe(4);
    expect(rollbackDraft.status).toBe('DRAFT');
    expect(rollbackDraft.rolledBackFrom).toBe(1);
    expect(rollbackDraft.checksum).toBe(v1Snapshot.checksum);

    // Historical version v1 was never mutated
    expect(rows.get('cfg-v1')).toEqual(v1Snapshot);
    expect(mockDb.platformConfigVersion.update).not.toHaveBeenCalled();
  });
});
