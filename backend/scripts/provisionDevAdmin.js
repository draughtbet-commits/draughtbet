#!/usr/bin/env node

/**
 * Draught Bet — Development-Only Admin Operator Provisioning & Revocation Tool
 *
 * Safely provisions a dedicated development admin operator using existing RBAC
 * (AdminRole + AdminRoleAssignment) and writes an AdminAuditLog entry.
 *
 * Guardrails:
 *   - Refuses to execute unless NODE_ENV === 'development'.
 *   - Never promotes an existing player account (isAdmin === false).
 *   - Never embeds default passwords; requires DEV_ADMIN_PASSWORD or stdin prompt.
 *   - Supports clean revocation via --revoke (with optional --delete for scratch accounts).
 *
 * Usage (PowerShell):
 *   $env:NODE_ENV="development"; $env:DEV_ADMIN_EMAIL="dev-ops@draughtbet.local"; $env:DEV_ADMIN_PASSWORD="..."; node backend/scripts/provisionDevAdmin.js --role SUPER_ADMIN
 *   $env:NODE_ENV="development"; node backend/scripts/provisionDevAdmin.js --revoke --email dev-ops@draughtbet.local
 */

import 'dotenv/config';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcrypt';
import prisma from '../src/utils/db.js';
import { ensureRoles, assignRole } from '../src/modules/rbac/service.js';
import { ADMIN_ROLES } from '../src/modules/rbac/permissions.js';
import { recordAdminAction } from '../src/modules/audit/service.js';

export function assertDevelopmentOnly(nodeEnv = process.env.NODE_ENV) {
  if (nodeEnv !== 'development') {
    throw new Error(
      `Refusing to run dev admin provisioning when NODE_ENV="${nodeEnv ?? ''}". Explicitly set NODE_ENV=development.`
    );
  }
}

export function validateOperatorPassword(password) {
  if (typeof password !== 'string' || password.length < 12) {
    throw new Error('Operator password must be at least 12 characters long.');
  }
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
    throw new Error('Operator password must contain uppercase, lowercase, and numeric characters.');
  }
}

export function validateOperatorEmail(email) {
  const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error('A valid --email (or DEV_ADMIN_EMAIL) is required.');
  }
  return normalized;
}

export function validateAdminRole(role) {
  if (!ADMIN_ROLES.includes(role)) {
    throw new Error(`Invalid role "${role}". Valid roles: ${ADMIN_ROLES.join(', ')}`);
  }
  return role;
}

export async function provisionDevAdmin({
  email,
  password,
  role = 'SUPPORT',
  fullName = 'Development Operator',
  nodeEnv = process.env.NODE_ENV,
  dbp = prisma
} = {}) {
  assertDevelopmentOnly(nodeEnv);
  const normalizedEmail = validateOperatorEmail(email);
  validateOperatorPassword(password);
  const validatedRole = validateAdminRole(role);

  const existing = await dbp.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true, email: true, isAdmin: true }
  });

  if (existing && !existing.isAdmin) {
    throw new Error(
      `Refusing to promote existing player account (${normalizedEmail}); use a dedicated operator email.`
    );
  }

  const passwordHash = await bcrypt.hash(password, 12);

  let operator;
  if (existing) {
    operator = await dbp.user.update({
      where: { id: existing.id },
      data: {
        passwordHash,
        isAdmin: true,
        isBanned: false,
        ageVerified: true,
        kycStatus: 'VERIFIED',
        fullName
      },
      select: { id: true, email: true, isAdmin: true }
    });
  } else {
    operator = await dbp.user.create({
      data: {
        email: normalizedEmail,
        fullName,
        passwordHash,
        isAdmin: true,
        isBanned: false,
        ageVerified: true,
        kycStatus: 'VERIFIED',
        countryCode: 'NG'
      },
      select: { id: true, email: true, isAdmin: true }
    });
  }

  await ensureRoles({ dbp });
  await assignRole(operator.id, validatedRole, { dbp });

  await recordAdminAction({
    adminId: operator.id,
    action: 'dev.admin.provisioned',
    outcome: 'SUCCESS',
    targetType: 'user',
    targetId: operator.id,
    metadata: { role: validatedRole, environment: nodeEnv },
    dbp
  });

  return { userId: operator.id, email: operator.email, role: validatedRole, created: !existing };
}

export async function revokeDevAdmin({
  email,
  deleteUser = false,
  nodeEnv = process.env.NODE_ENV,
  dbp = prisma
} = {}) {
  assertDevelopmentOnly(nodeEnv);
  const normalizedEmail = validateOperatorEmail(email);

  const existing = await dbp.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true, email: true, isAdmin: true }
  });

  if (!existing) {
    throw new Error(`No account found for ${normalizedEmail}`);
  }
  if (!existing.isAdmin) {
    throw new Error(`Refusing to modify non-admin player account (${normalizedEmail}).`);
  }

  await dbp.userSession.updateMany({
    where: { userId: existing.id, status: { in: ['ACTIVE', 'EXPIRED'] } },
    data: { status: 'REVOKED' }
  });
  await dbp.adminRoleAssignment.deleteMany({ where: { userId: existing.id } });
  await dbp.user.update({
    where: { id: existing.id },
    data: { isAdmin: false, isBanned: true }
  });

  await recordAdminAction({
    adminId: existing.id,
    action: 'dev.admin.revoked',
    outcome: 'SUCCESS',
    targetType: 'user',
    targetId: existing.id,
    metadata: { deleted: deleteUser, environment: nodeEnv },
    dbp
  });

  let deleted = false;
  if (deleteUser) {
    try {
      await dbp.adminAuditLog.deleteMany({ where: { adminId: existing.id } });
      await dbp.user.delete({ where: { id: existing.id } });
      deleted = true;
    } catch (err) {
      console.warn(
        `[DEV ADMIN] Revoked operator access and disabled login, but kept user row for FK audit/config integrity: ${err.message}`
      );
    }
  }

  return { userId: existing.id, email: existing.email, revoked: true, deleted };
}

function parseCliArgs(argv) {
  const args = { revoke: false, deleteUser: false, role: 'SUPPORT', email: process.env.DEV_ADMIN_EMAIL || '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--revoke') args.revoke = true;
    else if (arg === '--delete') args.deleteUser = true;
    else if (arg === '--email' && argv[i + 1]) args.email = argv[++i];
    else if (arg === '--role' && argv[i + 1]) args.role = argv[++i];
    else if (arg === '--name' && argv[i + 1]) args.fullName = argv[++i];
  }
  return args;
}

async function promptHiddenPassword() {
  if (!process.stdin.isTTY) {
    throw new Error('Set DEV_ADMIN_PASSWORD in the environment (non-interactive shell detected).');
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.stdoutMuted = true;
    rl._writeToOutput = function _writeToOutput(str) {
      if (!rl.stdoutMuted) process.stdout.write(str);
    };
    process.stdout.write('Enter development operator password (min 12 chars, upper/lower/digit): ');
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

const isMainModule = () => {
  if (!process.argv[1]) return false;
  return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
};

if (isMainModule()) {
  const args = parseCliArgs(process.argv.slice(2));
  (async () => {
    assertDevelopmentOnly();
    if (args.revoke) {
      const res = await revokeDevAdmin({ email: args.email, deleteUser: args.deleteUser });
      console.log('[DEV ADMIN] Revoked access:', JSON.stringify(res));
    } else {
      const password = process.env.DEV_ADMIN_PASSWORD || (await promptHiddenPassword());
      const res = await provisionDevAdmin({
        email: args.email,
        password,
        role: args.role,
        fullName: args.fullName
      });
      console.log('[DEV ADMIN] Provisioned operator:', JSON.stringify(res));
    }
    await prisma.$disconnect();
    process.exit(0);
  })().catch(async (err) => {
    console.error('[DEV ADMIN ERROR]', err.message);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
}
