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

/**
 * Server-owned eligibility gate for any action that moves money: withdrawals,
 * stakes and call-outs. Every user must have an Eligibility record on file
 * (created at registration from server-resolved geo evidence), remain in an
 * allowed country, be verified as an adult, and have passed KYC.
 *
 * `db` is either the Prisma client or an interactive-transaction client so
 * the check participates in the same transaction as the money movement.
 */
export const assertEligibleForMoney = async (db, userId) => {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      countryCode: true,
      kycStatus: true,
      eligibility: {
        select: { id: true, countryAllowed: true, ageVerified: true }
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
  if (user.kycStatus !== 'VERIFIED') {
    throw new KycRequiredError();
  }
};