import prisma from '../../utils/db.js';
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
}