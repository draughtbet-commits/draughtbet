import prisma from '../../utils/db.js';
import { GeoService } from '../../services/geoService.js';
import {
  assertEligibleForMoney,
  EligibilityRequiredError,
  CountryNotAllowedError,
  AgeNotVerifiedError,
  KycRequiredError,
  AccountRestrictedError,
  SelfExcludedError,
  TimeoutActiveError,
  StakeLimitExceededError,
  DepositLimitExceededError,
  ELIGIBILITY_ERROR_NAMES
} from '../../services/eligibilityService.js';
import { enforceDepositLimit } from '../saferPlay/service.js';

export {
  EligibilityRequiredError,
  CountryNotAllowedError,
  AgeNotVerifiedError,
  KycRequiredError,
  AccountRestrictedError,
  SelfExcludedError,
  TimeoutActiveError,
  StakeLimitExceededError,
  DepositLimitExceededError,
  ELIGIBILITY_ERROR_NAMES
};

const CODES_BY_NAME = {
  EligibilityRequiredError: 403,
  CountryNotAllowedError: 403,
  AgeNotVerifiedError: 403,
  KycRequiredError: 403,
  AccountRestrictedError: 403,
  SelfExcludedError: 403,
  TimeoutActiveError: 403,
  StakeLimitExceededError: 422,
  DepositLimitExceededError: 422
};

/**
 * Central per-operation eligibility facade. Each `canX` composes the
 * server-owned account gate with the safer-play rules that apply to that
 * operation. `statusCode(name)` lets controllers map the thrown errors to HTTP
 * statuses consistently.
 */
export class EligibilityService {
  constructor({ db = prisma } = {}) {
    this.db = db;
  }

  /** Money OUT: account state + KYC verified + self-exclusion. */
  async canWithdraw(userId, opts = {}) {
    await assertEligibleForMoney(this.db, userId, { requireKyc: true, ...opts });
  }

  /** Money IN: account state + self-exclusion + rolling 24h deposit limit. */
  async canDeposit(userId, amountMinorUnits, opts = {}) {
    await assertEligibleForMoney(this.db, userId, opts);
    await enforceDepositLimit(this.db, userId, amountMinorUnits, opts);
  }

  /** Play: account state + timeout + self-exclusion + per-match stake limit. */
  async canJoinMatch(userId, { stakeMinorUnits, ...opts } = {}) {
    await assertEligibleForMoney(this.db, userId, {
      enforceTimeout: true,
      stakeMinorUnits,
      ...opts
    });
  }

  /** Play: same gate as join; callouts are validated for tier bounds routeside. */
  async canCreateMatch(userId, { stakeMinorUnits, ...opts } = {}) {
    await assertEligibleForMoney(this.db, userId, {
      enforceTimeout: true,
      stakeMinorUnits,
      ...opts
    });
  }

  /**
   * Transaction-bound funding checkpoint for BOTH players, run inside the
   * interactive tx by the funding core. This is the authoritative gate — the
   * queue/route checks are only UX.
   */
  async canStake(db, userId, stakeMinorUnits, opts = {}) {
    await assertEligibleForMoney(db, userId, {
      enforceTimeout: true,
      stakeMinorUnits,
      ...opts
    });
  }

  static statusCode(error) {
    if (error && typeof error.name === 'string') {
      const code = CODES_BY_NAME[error.name];
      if (code) return code;
    }
    return 500;
  }

  /**
   * Read-only explanation of the eligibility gate for `action` (+ optional
   * `amountMinorUnits` where the gate is amount-sensitive: DEPOSIT rolls into
   * the 24h deposit limit, PLAY/STAKE into the per-match stake limit and the
   * active-timeout check). Never throws: returns
   *   { allowed: true,  requirements: [...] }                 — the gate passes
   *   { allowed: false, error: { code, message }, status }    — a gate blocks
   * Codes are the canonical gate error names (KycRequiredError, …) so clients
   * can read statusCode()/CODES_BY_NAME consistently. This is the contract §4
   * /me/eligibility surface — it explains, it never decides.
   */
  async explain(userId, { action, amountMinorUnits } = {}) {
    const normalized = ACTION_MAP[typeof action === 'string' ? action.trim().toUpperCase() : ''];
    if (!normalized) {
      return {
        allowed: false,
        error: { code: 'INVALID_ACTION', message: `Unknown eligibility action: ${action}` },
        status: 400
      };
    }

    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        countryCode: true,
        kycStatus: true,
        isBanned: true,
        eligibility: { select: { id: true, countryAllowed: true, ageVerified: true } },
        saferPlayProfile: {
          select: { stakeLimitMinorUnits: true, timeoutUntil: true, selfExcludedUntil: true }
        }
      }
    });

    const requirements = [];
    const fail = (error) => ({
      allowed: false,
      error: { code: error.name, message: error.message },
      status: EligibilityService.statusCode(error)
    });

    if (!user) return fail(new EligibilityRequiredError());
    if (!user.eligibility) return fail(new EligibilityRequiredError());
    requirements.push('eligibility:on_file');
    if (!user.eligibility.countryAllowed) return fail(new CountryNotAllowedError());
    if (!GeoService.isCountryAllowed(user.countryCode)) return fail(new CountryNotAllowedError());
    requirements.push('country:allowed');
    if (!user.eligibility.ageVerified) return fail(new AgeNotVerifiedError());
    requirements.push('age:verified');
    if (user.isBanned) return fail(new AccountRestrictedError());
    requirements.push('account:active');

    const profile = user.saferPlayProfile;
    if (profile) {
      const nowMs = Date.now();
      const excludedUntil = profile.selfExcludedUntil ? new Date(profile.selfExcludedUntil).getTime() : 0;
      if (excludedUntil > nowMs) {
        return fail(new SelfExcludedError(`Self-exclusion is active until ${new Date(excludedUntil).toISOString()}`));
      }
      if (normalized === 'PLAY') {
        const timedOutUntil = profile.timeoutUntil ? new Date(profile.timeoutUntil).getTime() : 0;
        if (timedOutUntil > nowMs) {
          return fail(new TimeoutActiveError(`A break is active until ${new Date(timedOutUntil).toISOString()}`));
        }
      }
      const amount = parseExplainAmount(amountMinorUnits);
      if (amount !== undefined && normalized === 'PLAY' && profile.stakeLimitMinorUnits !== null) {
        if (amount > BigInt(profile.stakeLimitMinorUnits)) {
          return fail(new StakeLimitExceededError());
        }
      }
    }
    requirements.push('safer_play:ok');

    if (normalized === 'DEPOSIT' && amountMinorUnits !== undefined && amountMinorUnits !== null) {
      try {
        await enforceDepositLimit(this.db, userId, amountMinorUnits);
      } catch (error) {
        if (error instanceof DepositLimitExceededError) return fail(error);
        throw error;
      }
    }
    if (normalized !== 'DEPOSIT' && normalized !== 'PLAY' && user.kycStatus !== 'VERIFIED') {
      return fail(new KycRequiredError());
    }
    if (user.kycStatus === 'VERIFIED') requirements.push('kyc:verified');

    return { allowed: true, requirements };
  }
}

const ACTION_MAP = Object.freeze({
  WITHDRAW: 'WITHDRAW',
  DEPOSIT: 'DEPOSIT',
  PLAY: 'PLAY',
  JOIN: 'PLAY',
  CREATE: 'PLAY',
  STAKE: 'PLAY'
});

const parseExplainAmount = (raw) => {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const str = typeof raw === 'number' || typeof raw === 'bigint' ? String(raw) : raw;
  if (typeof str !== 'string' || !/^\d+$/.test(str.trim())) return undefined;
  const value = BigInt(str.trim());
  if (value <= 0n) return undefined;
  return value;
};