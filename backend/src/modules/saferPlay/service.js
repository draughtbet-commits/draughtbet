import prisma from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { parseMinorUnits } from '../wallet/service.js';
import { DepositLimitExceededError } from '../../services/eligibilityService.js';

const MILLIS_PER_HOUR = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class TimeoutShrinkError extends Error {
  constructor(message = 'A break can only be extended') {
    super(message);
    this.name = 'TimeoutShrinkError';
  }
}

export class SelfExclusionShrinkError extends Error {
  constructor(message = 'Self-exclusion can only be extended') {
    super(message);
    this.name = 'SelfExclusionShrinkError';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Given a current (possibly null) base limit and a pending RAISE, resolve the
 * effective limit the player is actually under right now.
 */
export const effectiveValue = (
  base,
  pending,
  raisedAt,
  now,
  coolingHours
) => {
  if (pending != null && raisedAt != null) {
    const allowedAt = new Date(
      new Date(raisedAt).getTime() + coolingHours * MILLIS_PER_HOUR
    );
    if (now.getTime() >= allowedAt.getTime()) {
      return pending;
    }
  }
  return base ?? null;
};

export const SAFER_PLAY_DEFAULT_COOLING_HOURS = 24;

const readCoolingHours = async (dbp = prisma) => {
  try {
    const settings = await dbp.platformSettings.findUnique({
      where: { id: 'singleton' }
    });
    return Number(settings?.limitRaiseCoolingHours ?? SAFER_PLAY_DEFAULT_COOLING_HOURS);
  } catch {
    return SAFER_PLAY_DEFAULT_COOLING_HOURS;
  }
};

const resolveEffectiveDepositLimit = (profile, now, coolingHours) =>
  effectiveValue(
    profile.depositLimitMinorUnits ?? null,
    profile.pendingDepositLimitMinorUnits ?? null,
    profile.pendingDepositLimitRaisedAt,
    now,
    coolingHours
  );

const resolveEffectiveStakeLimit = (profile, now, coolingHours) =>
  effectiveValue(
    profile.stakeLimitMinorUnits ?? null,
    profile.pendingStakeLimitMinorUnits ?? null,
    profile.pendingStakeLimitRaisedAt,
    now,
    coolingHours
  );

const profilePayload = (profile, now, coolingHours) => ({
  depositLimitMinorUnits: profile.depositLimitMinorUnits?.toString() ?? null,
  pendingDepositLimitMinorUnits:
    profile.pendingDepositLimitMinorUnits?.toString() ?? null,
  pendingDepositLimitRaisedAt: profile.pendingDepositLimitRaisedAt ?? null,
  effectiveDepositLimitMinorUnits:
    resolveEffectiveDepositLimit(profile, now, coolingHours)?.toString() ?? null,
  stakeLimitMinorUnits: profile.stakeLimitMinorUnits?.toString() ?? null,
  pendingStakeLimitMinorUnits:
    profile.pendingStakeLimitMinorUnits?.toString() ?? null,
  pendingStakeLimitRaisedAt: profile.pendingStakeLimitRaisedAt ?? null,
  effectiveStakeLimitMinorUnits:
    resolveEffectiveStakeLimit(profile, now, coolingHours)?.toString() ?? null,
  timeoutUntil: profile.timeoutUntil ?? null,
  selfExcludedUntil: profile.selfExcludedUntil ?? null
});

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export const getProfile = async (userId, { now = new Date(), dbp = prisma } = {}) => {
  const profile = await dbp.saferPlayProfile.findUnique({
    where: { userId }
  });
  if (!profile) return null;
  const coolingHours = await readCoolingHours(dbp);
  return profilePayload(profile, now, coolingHours);
};

// ---------------------------------------------------------------------------
// Limits — deposit / stake
// ---------------------------------------------------------------------------

export const setDepositLimit = async (
  userId,
  rawAmount,
  { now = new Date(), dbp = prisma } = {}
) => {
  const clear = rawAmount === null || rawAmount === undefined || rawAmount === '';
  const parsed = clear ? null : parseMinorUnits(rawAmount);
  if (!clear && parsed === null) {
    const err = new Error('Invalid amount');
    err.name = 'InvalidAmountError';
    throw err;
  }

  const coolingHours = await readCoolingHours(dbp);
  const profile = await dbp.saferPlayProfile.findUnique({ where: { userId } });
  const currentBase = profile?.depositLimitMinorUnits ?? null;
  const currentPending = profile?.pendingDepositLimitMinorUnits ?? null;
  const currentRaisedAt = profile?.pendingDepositLimitRaisedAt ?? null;
  const currentEffective = profile
    ? resolveEffectiveDepositLimit(profile, now, coolingHours)
    : null;

  // Clear the limit entirely
  if (clear) {
    const updated = await dbp.saferPlayProfile.upsert({
      where: { userId },
      create: {
        userId,
        depositLimitMinorUnits: null,
        pendingDepositLimitMinorUnits: null,
        pendingDepositLimitRaisedAt: null
      },
      update: {
        depositLimitMinorUnits: null,
        pendingDepositLimitMinorUnits: null,
        pendingDepositLimitRaisedAt: null
      }
    });

    if (currentBase !== null || currentPending !== null) {
      await dbp.saferPlayEvent.create({
        data: {
          userId,
          action: 'LIFTED',
          field: 'depositLimitMinorUnits',
          oldValue: currentBase?.toString() ?? null,
          newValue: null
        }
      });
    }

    return profilePayload(updated, now, coolingHours);
  }

  // Lowering (or first-time set) — applies immediately.
  const isRaise =
    currentEffective !== null && parsed > currentEffective;

  if (!isRaise) {
    const updated = await dbp.saferPlayProfile.upsert({
      where: { userId },
      create: {
        userId,
        depositLimitMinorUnits: parsed,
        pendingDepositLimitMinorUnits: null,
        pendingDepositLimitRaisedAt: null
      },
      update: {
        depositLimitMinorUnits: parsed,
        pendingDepositLimitMinorUnits: null,
        pendingDepositLimitRaisedAt: null
      }
    });

    const action = currentBase === null ? 'SET' : 'UPDATED';
    await dbp.saferPlayEvent.create({
      data: {
        userId,
        action,
        field: 'depositLimitMinorUnits',
        oldValue: currentBase?.toString() ?? null,
        newValue: parsed.toString()
      }
    });

    return profilePayload(updated, now, coolingHours);
  }

  // Raise — staged pending; only effective after cooling window.
  const updated = await dbp.saferPlayProfile.upsert({
    where: { userId },
    create: {
      userId,
      depositLimitMinorUnits: currentEffective,
      pendingDepositLimitMinorUnits: parsed,
      pendingDepositLimitRaisedAt: now
    },
    update: {
      pendingDepositLimitMinorUnits: parsed,
      pendingDepositLimitRaisedAt: now
    }
  });

  await dbp.saferPlayEvent.create({
    data: {
      userId,
      action: 'UPDATED',
      field: 'pendingDepositLimitMinorUnits',
      oldValue: currentBase?.toString() ?? null,
      newValue: parsed.toString()
    }
  });

  return profilePayload(updated, now, coolingHours);
};

export const setStakeLimit = async (
  userId,
  rawAmount,
  { now = new Date(), dbp = prisma } = {}
) => {
  const clear = rawAmount === null || rawAmount === undefined || rawAmount === '';
  const parsed = clear ? null : parseMinorUnits(rawAmount);
  if (!clear && parsed === null) {
    const err = new Error('Invalid amount');
    err.name = 'InvalidAmountError';
    throw err;
  }

  const coolingHours = await readCoolingHours(dbp);
  const profile = await dbp.saferPlayProfile.findUnique({ where: { userId } });
  const currentBase = profile?.stakeLimitMinorUnits ?? null;
  const currentPending = profile?.pendingStakeLimitMinorUnits ?? null;
  const currentEffective = profile
    ? resolveEffectiveStakeLimit(profile, now, coolingHours)
    : null;

  if (clear) {
    const updated = await dbp.saferPlayProfile.upsert({
      where: { userId },
      create: {
        userId,
        stakeLimitMinorUnits: null,
        pendingStakeLimitMinorUnits: null,
        pendingStakeLimitRaisedAt: null
      },
      update: {
        stakeLimitMinorUnits: null,
        pendingStakeLimitMinorUnits: null,
        pendingStakeLimitRaisedAt: null
      }
    });

    if (currentBase !== null || currentPending !== null) {
      await dbp.saferPlayEvent.create({
        data: {
          userId,
          action: 'LIFTED',
          field: 'stakeLimitMinorUnits',
          oldValue: currentBase?.toString() ?? null,
          newValue: null
        }
      });
    }

    return profilePayload(updated, now, coolingHours);
  }

  const isRaise = currentEffective !== null && parsed > currentEffective;

  if (!isRaise) {
    const updated = await dbp.saferPlayProfile.upsert({
      where: { userId },
      create: {
        userId,
        stakeLimitMinorUnits: parsed,
        pendingStakeLimitMinorUnits: null,
        pendingStakeLimitRaisedAt: null
      },
      update: {
        stakeLimitMinorUnits: parsed,
        pendingStakeLimitMinorUnits: null,
        pendingStakeLimitRaisedAt: null
      }
    });

    const action = currentBase === null ? 'SET' : 'UPDATED';
    await dbp.saferPlayEvent.create({
      data: {
        userId,
        action,
        field: 'stakeLimitMinorUnits',
        oldValue: currentBase?.toString() ?? null,
        newValue: parsed.toString()
      }
    });

    return profilePayload(updated, now, coolingHours);
  }

  const updated = await dbp.saferPlayProfile.upsert({
    where: { userId },
    create: {
      userId,
      stakeLimitMinorUnits: currentEffective,
      pendingStakeLimitMinorUnits: parsed,
      pendingStakeLimitRaisedAt: now
    },
    update: {
      pendingStakeLimitMinorUnits: parsed,
      pendingStakeLimitRaisedAt: now
    }
  });

  await dbp.saferPlayEvent.create({
    data: {
      userId,
      action: 'UPDATED',
      field: 'pendingStakeLimitMinorUnits',
      oldValue: currentBase?.toString() ?? null,
      newValue: parsed.toString()
    }
  });

  return profilePayload(updated, now, coolingHours);
};

// ---------------------------------------------------------------------------
// Timeout / self-exclusion (extend-only)
// ---------------------------------------------------------------------------

export const startTimeout = async (
  userId,
  rawMinutes,
  { now = new Date(), dbp = prisma } = {}
) => {
  const minutes = Number(rawMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0 || !Number.isInteger(minutes)) {
    const err = new Error('Invalid timeout duration');
    err.name = 'InvalidTimeoutError';
    throw err;
  }
  const until = new Date(now.getTime() + minutes * 60_000);
  const profile = await dbp.saferPlayProfile.findUnique({ where: { userId } });
  const existing = profile?.timeoutUntil ? new Date(profile.timeoutUntil) : null;
  if (existing && existing.getTime() >= until.getTime()) {
    throw new TimeoutShrinkError('An active break can only be extended');
  }
  const updated = await dbp.saferPlayProfile.upsert({
    where: { userId },
    create: { userId, timeoutUntil: until },
    update: { timeoutUntil: until }
  });

  await dbp.saferPlayEvent.create({
    data: {
      userId,
      action: 'UPDATED',
      field: 'timeoutUntil',
      oldValue: existing?.toISOString() ?? null,
      newValue: until.toISOString()
    }
  });

  const coolingHours = await readCoolingHours(dbp);
  return profilePayload(updated, now, coolingHours);
};

export const extendSelfExclusion = async (
  userId,
  rawUntil,
  { now = new Date(), dbp = prisma } = {}
) => {
  let until;
  if (rawUntil && typeof rawUntil === 'string' && rawUntil.includes('d')) {
    const days = Number(rawUntil.replace(/d$/i, ''));
    if (!Number.isFinite(days) || days <= 0) {
      const err = new Error('Invalid self-exclusion duration');
      err.name = 'InvalidSelfExclusionError';
      throw err;
    }
    until = new Date(now.getTime() + days * 86_400_000);
  } else if (rawUntil instanceof Date) {
    until = rawUntil;
  } else if (typeof rawUntil === 'string') {
    until = new Date(rawUntil);
  } else if (typeof rawUntil === 'number') {
    until = new Date(rawUntil);
  } else {
    const err = new Error('self-exclusion until is required');
    err.name = 'InvalidSelfExclusionError';
    throw err;
  }

  if (!until || !(until instanceof Date) || Number.isNaN(until.getTime()) || until.getTime() <= now.getTime()) {
    const err = new Error('Self-exclusion end must be in the future');
    err.name = 'InvalidSelfExclusionError';
    throw err;
  }

  const profile = await dbp.saferPlayProfile.findUnique({ where: { userId } });
  const existing = profile?.selfExcludedUntil
    ? new Date(profile.selfExcludedUntil)
    : null;
  if (existing && existing.getTime() >= until.getTime()) {
    throw new SelfExclusionShrinkError(
      'An active self-exclusion can only be extended'
    );
  }

  const updated = await dbp.saferPlayProfile.upsert({
    where: { userId },
    create: { userId, selfExcludedUntil: until },
    update: { selfExcludedUntil: until }
  });

  await dbp.saferPlayEvent.create({
    data: {
      userId,
      action: existing ? 'UPDATED' : 'SET',
      field: 'selfExcludedUntil',
      oldValue: existing?.toISOString() ?? null,
      newValue: until.toISOString()
    }
  });

  const coolingHours = await readCoolingHours(dbp);
  return profilePayload(updated, now, coolingHours);
};

// ---------------------------------------------------------------------------
// Admin lifts (the player-visible side is extend-only; ending is admin-only)
// ---------------------------------------------------------------------------

export const clearTimeoutByAdmin = async (userId, { actorId = null, dbp = prisma } = {}) => {
  const profile = await dbp.saferPlayProfile.findUnique({ where: { userId } });
  const existing = profile?.timeoutUntil ? new Date(profile.timeoutUntil) : null;
  if (!existing) return null;

  const updated = await dbp.saferPlayProfile.update({
    where: { userId },
    data: { timeoutUntil: null }
  });
  await dbp.saferPlayEvent.create({
    data: {
      userId,
      action: 'LIFTED',
      field: 'timeoutUntil',
      oldValue: existing.toISOString(),
      newValue: null
    }
  });
  return updated;
};

export const endSelfExclusionByAdmin = async (userId, { actorId = null, dbp = prisma } = {}) => {
  const profile = await dbp.saferPlayProfile.findUnique({ where: { userId } });
  const existing = profile?.selfExcludedUntil ? new Date(profile.selfExcludedUntil) : null;
  if (!existing) return null;

  const updated = await dbp.saferPlayProfile.update({
    where: { userId },
    data: { selfExcludedUntil: null }
  });
  await dbp.saferPlayEvent.create({
    data: {
      userId,
      action: 'LIFTED',
      field: 'selfExcludedUntil',
      oldValue: existing.toISOString(),
      newValue: null
    }
  });
  return updated;
};

// ---------------------------------------------------------------------------
// Deposit limit enforcement
// ---------------------------------------------------------------------------

export const enforceDepositLimit = async (
  dbp,
  userId,
  amountMinorUnits,
  { now = new Date() } = {}
) => {
  const profile = await dbp.saferPlayProfile.findUnique({ where: { userId } });
  if (!profile) return;
  const coolingHours = await readCoolingHours(dbp);
  const limit = resolveEffectiveDepositLimit(profile, now, coolingHours);
  if (limit === null) return;

  const since = new Date(now.getTime() - 24 * 3600e3);
  const agg = await dbp.depositIntent.aggregate({
    where: {
      userId,
      status: 'COMPLETED',
      createdAt: { gte: since }
    },
    _sum: { amountMinorUnits: true }
  });
  const spent = agg._sum.amountMinorUnits ?? 0n;
  if (spent + BigInt(amountMinorUnits) > limit) {
    throw new DepositLimitExceededError();
  }
};