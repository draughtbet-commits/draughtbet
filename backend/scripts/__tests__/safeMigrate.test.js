import { jest, describe, it, expect } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  analyzeMigrationSql,
  computeMigrationChecksum,
  discoverMigrations,
  runMigrationPreflight,
  executeSafeMigrate
} from '../safeMigrate.js';

describe('safeMigrate — safe ordered Prisma migration preflight & execution', () => {
  it('discovers all repository Prisma migrations in deterministic lexicographic order', () => {
    const { migrations } = discoverMigrations();
    expect(migrations.length).toBeGreaterThanOrEqual(25);
    const names = migrations.map((m) => m.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(migrations[0].name).toBe('20260826043453_init');
  });

  it('detects destructive SQL and unsafe enum add+use in the same transaction', () => {
    const destructive = analyzeMigrationSql(
      '20261201000000_drop_something',
      'DROP TABLE "User"; TRUNCATE "LedgerEntry";'
    );
    expect(destructive.hazards.map((h) => h.code)).toEqual(['DROP_TABLE', 'TRUNCATE']);

    const enumHazard = analyzeMigrationSql(
      '20261201000001_bad_enum',
      `ALTER TYPE "RiskCaseStatus" ADD VALUE 'CRITICAL_NEW';
       UPDATE "RiskCase" SET status = 'CRITICAL_NEW' WHERE status = 'OPEN';`
    );
    expect(enumHazard.hazards.map((h) => h.code)).toContain('ENUM_ADD_AND_USE_SAME_TX');
  });

  it('blocks pending destructive migrations and failed _prisma_migrations rows without running deploy', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'draughtbet-mig-'));
    try {
      const m1Dir = path.join(tmpDir, '20260101000000_init');
      const m2Dir = path.join(tmpDir, '20260102000000_drop_data');
      fs.mkdirSync(m1Dir, { recursive: true });
      fs.mkdirSync(m2Dir, { recursive: true });
      const sql1 = 'CREATE TABLE "Example" ("id" TEXT PRIMARY KEY);';
      const sql2 = 'DROP TABLE "Example";';
      fs.writeFileSync(path.join(m1Dir, 'migration.sql'), sql1);
      fs.writeFileSync(path.join(m2Dir, 'migration.sql'), sql2);

      const mockDb = {
        $queryRawUnsafe: jest.fn(async (sql) => {
          if (sql.includes('to_regclass')) return [{ reg: '_prisma_migrations' }];
          if (sql.includes('FROM "_prisma_migrations"')) {
            return [
              {
                migration_name: '20260101000000_init',
                checksum: computeMigrationChecksum(sql1),
                finished_at: new Date(),
                rolled_back_at: null,
                applied_steps_count: 1
              }
            ];
          }
          if (sql.includes('information_schema.tables')) return [];
          if (sql.includes('pg_indexes')) return [];
          return [{ '?column?': 1 }];
        })
      };

      const deploySpy = jest.fn();
      const blocked = await executeSafeMigrate({
        dbp: mockDb,
        apply: true,
        allowDestructive: false,
        migrationsDir: tmpDir,
        runDeploy: deploySpy
      });

      expect(blocked.ok).toBe(false);
      expect(blocked.deployed).toBe(false);
      expect(deploySpy).not.toHaveBeenCalled();
      expect(blocked.errors.some((e) => e.includes('DROP TABLE'))).toBe(true);

      // Failed migration in DB must also abort
      mockDb.$queryRawUnsafe.mockImplementation(async (sql) => {
        if (sql.includes('to_regclass')) return [{ reg: '_prisma_migrations' }];
        if (sql.includes('FROM "_prisma_migrations"')) {
          return [
            {
              migration_name: '20260101000000_init',
              checksum: computeMigrationChecksum(sql1),
              finished_at: null,
              rolled_back_at: null,
              applied_steps_count: 0
            }
          ];
        }
        return [{ '?column?': 1 }];
      });

      const failedState = await runMigrationPreflight({ dbp: mockDb, migrationsDir: tmpDir });
      expect(failedState.ok).toBe(false);
      expect(failedState.failedMigrations).toContain('20260101000000_init');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('delegates clean pending migrations strictly to official prisma migrate deploy (never raw SQL concat)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'draughtbet-mig-clean-'));
    try {
      const m1Dir = path.join(tmpDir, '20260101000000_additive');
      fs.mkdirSync(m1Dir, { recursive: true });
      fs.writeFileSync(
        path.join(m1Dir, 'migration.sql'),
        'ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "safeFlag" BOOLEAN NOT NULL DEFAULT false;'
      );

      const mockDb = {
        $queryRawUnsafe: jest.fn(async (sql) => {
          if (sql.includes('to_regclass')) return [{ reg: null }];
          return [{ '?column?': 1 }];
        })
      };

      const deploySpy = jest.fn();

      // Default check mode does NOT deploy
      const checkRes = await executeSafeMigrate({
        dbp: mockDb,
        apply: false,
        migrationsDir: tmpDir,
        runDeploy: deploySpy
      });
      expect(checkRes.ok).toBe(true);
      expect(checkRes.deployed).toBe(false);
      expect(deploySpy).not.toHaveBeenCalled();

      // Apply mode invokes official Prisma CLI deploy function once
      const applyRes = await executeSafeMigrate({
        dbp: mockDb,
        apply: true,
        migrationsDir: tmpDir,
        runDeploy: deploySpy
      });
      expect(applyRes.ok).toBe(true);
      expect(applyRes.deployed).toBe(true);
      expect(deploySpy).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
