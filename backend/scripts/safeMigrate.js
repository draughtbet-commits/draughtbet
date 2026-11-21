#!/usr/bin/env node

/**
 * Draught Bet — Safe Prisma Migration Preflight & Execution Runner
 *
 * Replaces unsafe raw SQL concatenation/execution with deterministic preflight
 * validation followed by official `prisma migrate deploy` execution (which uses
 * Prisma's advisory locking, per-migration transactional boundaries where
 * supported by PostgreSQL, and `_prisma_migrations` checksum tracking).
 *
 * Modes:
 *   --check (default)  Read-only preflight: ordering, SQL hazard scan,
 *                      `_prisma_migrations` integrity, failed-migration check,
 *                      and live schema compatibility check.
 *   --apply            Runs all preflight checks first; only if clean, invokes
 *                      `prisma migrate deploy`. Never concatenates raw SQL.
 *   --allow-destructive Required if a PENDING migration contains DROP/TRUNCATE.
 */

import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_ROOT = path.resolve(__dirname, '..');
const DEFAULT_MIGRATIONS_DIR = path.join(BACKEND_ROOT, 'prisma', 'migrations');

const MIGRATION_DIR_PATTERN = /^(\d{14})_([a-zA-Z0-9_-]+)$/;

const REQUIRED_CORE_TABLES = [
  'User',
  'Wallet',
  'LedgerAccount',
  'LedgerTransaction',
  'LedgerEntry',
  'AdminRole',
  'AdminRoleAssignment',
  'AdminAuditLog',
  'AdminMfa',
  'UserSession',
  'PlatformConfigVersion',
  'ConfigApproval'
];

const REQUIRED_KEY_INDEXES = [
  'UserSession_refreshTokenHash_key',
  'platform_config_single_active_idx',
  'AdminMfa_userId_key'
];

/**
 * Computes the exact SHA-256 hex digest Prisma stores in `_prisma_migrations.checksum`.
 */
export function computeMigrationChecksum(sqlBufferOrString) {
  return crypto.createHash('sha256').update(sqlBufferOrString).digest('hex');
}

/**
 * Strips SQL comments so static safety analysis doesn't trigger on comments.
 */
export function stripSqlComments(sql) {
  return String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\r\n]*/g, ' ');
}

/**
 * Scans a migration SQL file for PostgreSQL transactional hazards and
 * potentially destructive operations against existing production data.
 */
export function analyzeMigrationSql(migrationName, sql) {
  const clean = stripSqlComments(sql);
  const warnings = [];
  const hazards = [];

  // 1. Destructive statements (DROP TABLE / DROP COLUMN / TRUNCATE / DELETE FROM)
  if (/\bDROP\s+TABLE\b/i.test(clean)) {
    hazards.push({ code: 'DROP_TABLE', message: `${migrationName}: contains DROP TABLE` });
  }
  if (/\bDROP\s+COLUMN\b/i.test(clean)) {
    hazards.push({ code: 'DROP_COLUMN', message: `${migrationName}: contains DROP COLUMN` });
  }
  if (/\bTRUNCATE\s+(?:TABLE\s+)?/i.test(clean)) {
    hazards.push({ code: 'TRUNCATE', message: `${migrationName}: contains TRUNCATE` });
  }
  if (/\bDELETE\s+FROM\b/i.test(clean)) {
    hazards.push({ code: 'DELETE_FROM', message: `${migrationName}: contains DELETE FROM` });
  }

  // 2. Non-transactional / manual BEGIN..COMMIT blocks inside Prisma-managed migration
  if (/^\s*BEGIN\s*;/im.test(clean) || /^\s*COMMIT\s*;/im.test(clean)) {
    warnings.push({
      code: 'EXPLICIT_TRANSACTION_CONTROL',
      message: `${migrationName}: contains explicit BEGIN/COMMIT which can conflict with Prisma transaction wrapping`
    });
  }

  // 3. ALTER TYPE ... ADD VALUE mixed with immediate use of the new enum value in same migration
  const enumAddMatches = [...clean.matchAll(/ALTER\s+TYPE\s+"?(\w+)"?\s+ADD\s+VALUE(?:\s+IF\s+NOT\s+EXISTS)?\s+'([^']+)'/gi)];
  for (const match of enumAddMatches) {
    const [, typeName, enumVal] = match;
    const remainder = clean.slice(match.index + match[0].length);
    const valPattern = new RegExp(`'${enumVal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`, 'i');
    if (valPattern.test(remainder) && /\b(INSERT|UPDATE|DEFAULT|WHERE)\b/i.test(remainder)) {
      hazards.push({
        code: 'ENUM_ADD_AND_USE_SAME_TX',
        message: `${migrationName}: adds enum value "${typeName}.${enumVal}" and references it in the same migration (PostgreSQL rejects unsafe use of new enum value in the same transaction)`
      });
    }
  }

  // 4. SET NOT NULL without obvious backfill/UPDATE in same migration
  if (/\bSET\s+NOT\s+NULL\b/i.test(clean) && !/\bUPDATE\s+/i.test(clean)) {
    warnings.push({
      code: 'SET_NOT_NULL_WITHOUT_BACKFILL',
      message: `${migrationName}: sets NOT NULL without an explicit backfill UPDATE; verify zero NULL rows exist in production`
    });
  }

  return { migrationName, warnings, hazards };
}

/**
 * Loads all Prisma migration directories in deterministic lexicographic order
 * and validates naming, timestamp ordering, and SQL presence.
 */
export function discoverMigrations(migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`Migrations directory not found: ${migrationsDir}`);
  }

  const entries = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));

  const migrations = [];
  const seenTimestamps = new Map();
  const orderingWarnings = [];

  for (const name of entries) {
    const match = MIGRATION_DIR_PATTERN.exec(name);
    if (!match) {
      throw new Error(`Invalid migration directory name "${name}" (expected YYYYMMDDHHMMSS_description)`);
    }
    const timestamp = match[1];
    const sqlPath = path.join(migrationsDir, name, 'migration.sql');
    if (!fs.existsSync(sqlPath)) {
      throw new Error(`Missing migration.sql in ${name}`);
    }

    if (seenTimestamps.has(timestamp)) {
      orderingWarnings.push(
        `Duplicate migration timestamp ${timestamp}: "${seenTimestamps.get(timestamp)}" and "${name}"`
      );
    } else {
      seenTimestamps.set(timestamp, name);
    }

    const rawBytes = fs.readFileSync(sqlPath);
    const sql = rawBytes.toString('utf8');
    const checksum = computeMigrationChecksum(rawBytes);
    const analysis = analyzeMigrationSql(name, sql);

    migrations.push({
      name,
      timestamp,
      sqlPath,
      checksum,
      sql,
      warnings: analysis.warnings,
      hazards: analysis.hazards
    });
  }

  return { migrations, orderingWarnings };
}

/**
 * Runs complete preflight checks comparing local Prisma migrations against the
 * live database `_prisma_migrations` history and schema tables/indexes.
 */
export async function runMigrationPreflight({
  dbp,
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
  allowDestructive = false
} = {}) {
  const { migrations, orderingWarnings } = discoverMigrations(migrationsDir);
  const errors = [];
  const warnings = [...orderingWarnings];

  // 1. Connectivity check
  await dbp.$queryRawUnsafe('SELECT 1');

  // 2. Inspect `_prisma_migrations` if it exists (fresh DBs won't have it yet)
  const migTableRows = await dbp.$queryRawUnsafe(
    `SELECT to_regclass('public._prisma_migrations')::text AS reg`
  );
  const hasMigrationsTable = Boolean(migTableRows?.[0]?.reg);

  const appliedMap = new Map();
  const failedMigrations = [];

  if (hasMigrationsTable) {
    const dbMigs = await dbp.$queryRawUnsafe(
      `SELECT migration_name, checksum, finished_at, rolled_back_at, applied_steps_count
       FROM "_prisma_migrations"
       ORDER BY started_at ASC`
    );

    for (const row of dbMigs) {
      if (!row.finished_at && !row.rolled_back_at) {
        failedMigrations.push(row.migration_name);
        errors.push(
          `Database has an unfinished/failed migration "${row.migration_name}". Resolve it explicitly before applying new migrations.`
        );
      } else if (row.finished_at && !row.rolled_back_at) {
        appliedMap.set(row.migration_name, row);
      }
    }
  }

  // 3. Classify applied vs pending and verify checksum stability for applied migrations
  const applied = [];
  const pending = [];
  const checksumDrifts = [];

  for (const mig of migrations) {
    const record = appliedMap.get(mig.name);
    if (record) {
      applied.push(mig.name);
      if (record.checksum && record.checksum !== mig.checksum) {
        checksumDrifts.push({
          migrationName: mig.name,
          expected: record.checksum,
          actual: mig.checksum
        });
        warnings.push(
          `Checksum mismatch on already-applied migration "${mig.name}" (DB=${record.checksum.slice(0, 12)}…, local=${mig.checksum.slice(0, 12)}…). Never mutate historical applied migrations.`
        );
      }
    } else {
      pending.push(mig);
      for (const w of mig.warnings) {
        warnings.push(w.message);
      }
      for (const h of mig.hazards) {
        if (h.code === 'ENUM_ADD_AND_USE_SAME_TX') {
          errors.push(h.message);
        } else if (!allowDestructive) {
          errors.push(`${h.message} (blocked without --allow-destructive)`);
        } else {
          warnings.push(`${h.message} (allowed via --allow-destructive)`);
        }
      }
    }
  }

  // Detect applied DB migrations missing locally
  const localNames = new Set(migrations.map((m) => m.name));
  for (const appliedName of appliedMap.keys()) {
    if (!localNames.has(appliedName)) {
      errors.push(
        `Database records applied migration "${appliedName}" which is missing from ${migrationsDir}.`
      );
    }
  }

  // 4. Schema compatibility check against existing production DB
  let missingTables = [];
  let missingIndexes = [];
  if (hasMigrationsTable && applied.length > 0) {
    const tables = await dbp.$queryRawUnsafe(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
    );
    const tableSet = new Set(tables.map((t) => t.table_name));
    missingTables = REQUIRED_CORE_TABLES.filter((t) => !tableSet.has(t));
    if (missingTables.length > 0 && pending.length === 0) {
      errors.push(`Live schema missing required core tables: ${missingTables.join(', ')}`);
    }

    const indexes = await dbp.$queryRawUnsafe(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`
    );
    const indexSet = new Set(indexes.map((i) => i.indexname));
    missingIndexes = REQUIRED_KEY_INDEXES.filter((idx) => !indexSet.has(idx));
    if (missingIndexes.length > 0 && pending.length === 0) {
      errors.push(`Live schema missing required security/integrity indexes: ${missingIndexes.join(', ')}`);
    }
  }

  return {
    ok: errors.length === 0,
    totalLocalMigrations: migrations.length,
    appliedCount: applied.length,
    pendingMigrations: pending.map((m) => m.name),
    failedMigrations,
    checksumDrifts,
    missingTables,
    missingIndexes,
    warnings,
    errors
  };
}

/**
 * Applies pending migrations strictly via Prisma's official `prisma migrate deploy`
 * binary after passing preflight. Never concatenates raw SQL.
 */
export async function executeSafeMigrate({
  dbp,
  apply = false,
  allowDestructive = false,
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
  runDeploy = null
} = {}) {
  const preflight = await runMigrationPreflight({
    dbp,
    migrationsDir,
    allowDestructive
  });

  if (!preflight.ok) {
    return { ...preflight, deployed: false };
  }

  if (!apply) {
    return { ...preflight, deployed: false, mode: 'check' };
  }

  if (preflight.pendingMigrations.length === 0) {
    return { ...preflight, deployed: false, upToDate: true, mode: 'apply' };
  }

  const deployFn =
    runDeploy ||
    (() => {
      const prismaBin = path.join(BACKEND_ROOT, 'node_modules', 'prisma', 'build', 'index.js');
      execFileSync(process.execPath, [prismaBin, 'migrate', 'deploy'], {
        cwd: BACKEND_ROOT,
        stdio: 'inherit',
        env: process.env
      });
    });

  deployFn();
  return { ...preflight, deployed: true, mode: 'apply' };
}

const isMainModule = () => {
  if (!process.argv[1]) return false;
  return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
};

if (isMainModule()) {
  const args = new Set(process.argv.slice(2));
  const apply = args.has('--apply');
  const allowDestructive = args.has('--allow-destructive');

  (async () => {
    const { default: prisma } = await import('../src/utils/db.js');
    try {
      const report = await executeSafeMigrate({
        dbp: prisma,
        apply,
        allowDestructive
      });
      console.log(JSON.stringify(report, null, 2));
      if (!report.ok) {
        process.exitCode = 1;
      }
    } finally {
      await prisma.$disconnect();
    }
  })().catch((err) => {
    console.error('[safeMigrate] FATAL:', err.message);
    process.exit(1);
  });
}
