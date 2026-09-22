import { GeoService } from './geoService.js';

export class EligibilityRequiredError extends Error {
  constructor(message = 'Account eligibility has not been verified') {
    super(message);
    this.name = 'EligibilityRequiredError';
  }
}

export class CountryNotAllowedError extends Error {
  constructor(message = 'This app is not available in your country') {
    super(message);
    this.name = 'CountryNotAllowedError';
  }
}

export class AgeNotVerifiedError extends Error {
  constructor(message = 'Age has not been verified') {
    super(message);
    this.name = 'AgeNotVerifiedError';
  }
}

export class KycRequiredError extends Error {
  constructor(message = 'KYC verification is required for this action') {
    super(message);
    this.name = 'KycRequiredError';
  }
}

export class AccountRestrictedError extends Error {
  constructor(message = 'This account is restricted') {
    super(message);
    this.name = 'AccountRestrictedError';
  }
}

export class SelfExcludedError extends Error {
  constructor(message = 'Self-exclusion is active') {
    super(message);
    this.name = 'SelfExcludedError';
  }
}

export class TimeoutActiveError extends Error {
  constructor(message = 'A break is active until the timeout ends') {
    super(message);
    this.name = 'TimeoutActiveError';
  }
}

export class DepositLimitExceededError extends Error {
  constructor(message = 'Deposit would exceed your daily limit') {
    super(message);
    this.name = 'DepositLimitExceededError';
  }
}

export class StakeLimitExceededError extends Error {
  constructor(message = 'Stake exceeds your safer-play limit') {
    super(message);
    this.name = 'StakeLimitExceededError';
  }
}

export const ELIGIBILITY_ERROR_NAMES = Object.freeze([
  'EligibilityRequiredError',
  'CountryNotAllowedError',
  'AgeNotVerifiedError',
  'KycRequiredError',
  'AccountRestrictedError',
  'SelfExcludedError',
  'TimeoutActiveError',
  'StakeLimitExceededError'
]);

/**
 * Server-owned eligibility gate for any action that touches the account:
 *
 * Every user must have an Eligibility record on file (created at registration
 * from server-resolved geo evidence), remain in an allowed country, be verified
 * as an adult, and not be banned. Safer-play then layers on:
 *
 *   - self-exclusion   (blocks EVERYTHING, money + play)
 *   - timeout          (blocks PLAY only, when enforceTimeout is set)
 *   - stake limit      (per-match ceiling, when a stake is supplied)
 *   - KYC              (only the money-OUT gates require it)
 *
 * `db` is either the Prisma client or an interactive-transaction client so the
 * check participates in the same transaction as the money movement.
 */
export const assertEligibleForMoney = async (
  db,
  userId,
  {
    requireKyc = false,
    enforceTimeout = false,
    stakeMinorUnits = undefined,
    now = new Date()
  } = {}
) => {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      countryCode: true,
      kycStatus: true,
      isBanned: true,
      eligibility: {
        select: { id: true, countryAllowed: true, ageVerified: true }
      },
      saferPlayProfile: {
        select: {
          stakeLimitMinorUnits: true,
          timeoutUntil: true,
          selfExcludedUntil: true
        }
      }
    }
  });

  if (!user || !user.eligibility) {
    throw new EligibilityRequiredError();
  }
  // The recorded decision at registration…
  if (!user.eligibility.countryAllowed) {
    throw new CountryNotAllowedError();
  }
  // …plus a live re-check so a new country ban applies to money movement.
  if (!GeoService.isCountryAllowed(user.countryCode)) {
    throw new CountryNotAllowedError();
  }
  if (!user.eligibility.ageVerified) {
    throw new AgeNotVerifiedError();
  }
  if (user.isBanned) {
    throw new AccountRestrictedError();
  }

  const nowMs = now.getTime();
  const profile = user.saferPlayProfile;
  if (profile) {
    const excludedUntil = profile.selfExcludedUntil
      ? new Date(profile.selfExcludedUntil).getTime()
      : 0;
    if (excludedUntil > nowMs) {
      throw new SelfExcludedError(
        `Self-exclusion is active until ${new Date(excludedUntil).toISOString()}`
      );
    }
    if (enforceTimeout) {
      const timedOutUntil = profile.timeoutUntil
        ? new Date(profile.timeoutUntil).getTime()
        : 0;
      if (timedOutUntil > nowMs) {
        throw new TimeoutActiveError(
          `A break is active until ${new Date(timedOutUntil).toISOString()}`
        );
      }
    }
    if (
      stakeMinorUnits !== undefined &&
      stakeMinorUnits !== null &&
      profile.stakeLimitMinorUnits !== null &&
      profile.stakeLimitMinorUnits !== undefined
    ) {
      const stake = BigInt(stakeMinorUnits);
      if (stake > BigInt(profile.stakeLimitMinorUnits)) {
        throw new StakeLimitExceededError();
      }
    }
  }

  if (requireKyc && user.kycStatus !== 'VERIFIED') {
    throw new KycRequiredError();
  }
};