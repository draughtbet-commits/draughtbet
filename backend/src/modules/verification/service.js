import prisma from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { KycRequiredError } from '../../services/eligibilityService.js';
import { createKycProvider, KycProviderError } from './providerAdapter.js';

export class KycAlreadyVerifiedError extends Error {
  constructor(message = 'KYC verification is already complete') {
    super(message);
    this.name = 'KycAlreadyVerifiedError';
  }
}

export class KycInProgressError extends Error {
  constructor(message = 'KYC verification is already in progress') {
    super(message);
    this.name = 'KycInProgressError';
  }
}

export class InvalidVerificationTypeError extends Error {
  constructor(message = 'Unsupported verification type') {
    super(message);
    this.name = 'InvalidVerificationTypeError';
  }
}

export const VERIFICATION_CHECK_TYPES = Object.freeze([
  'ID_DOCUMENT',
  'SELFIE',
  'PROOF_OF_ADDRESS',
  'BVN',
  'NIN'
]);

export class KycRejectedError extends Error {
  constructor(message = 'Verification did not pass. You may try again.') {
    super(message);
    this.name = 'KycRejectedError';
  }
}

export const KYC_STATUSES = Object.freeze([
  'NOT_REQUIRED',
  'REQUIRED',
  'STARTED',
  'PENDING',
  'UNDER_REVIEW',
  'VERIFIED',
  'REJECTED',
  'EXPIRED'
]);

export const kycStatusView = (user) => {
  const latest = user.verificationCases?.[0] ?? null;
  return {
    kycStatus: user.kycStatus,
    case: latest
      ? {
          id: latest.id,
          status: latest.status,
          provider: latest.provider,
          createdAt: latest.createdAt,
          updatedAt: latest.updatedAt,
          checks: (latest.checks ?? []).map((c) => ({
            id: c.id,
            type: c.type,
            status: c.status,
            verifiedAt: c.verifiedAt
          }))
        }
      : null
  };
};

export const getKycStatus = async (userId, { dbp = prisma } = {}) => {
  const user = await dbp.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      kycStatus: true,
      verificationCases: {
        orderBy: { updatedAt: 'desc' },
        take: 1,
        include: { checks: true }
      }
    }
  });
  if (!user) throw new KycRequiredError('Account not found');
  return kycStatusView(user);
};

/**
 * Runs a verification pass for the player through the injected (or simulated)
 * provider. The atomic result is projected onto the VerificationCase/Check rows
 * and the User.kycStatus compatibility column.
 *
 * A pass also flips `ageVerified` when the case passes — the provider has
 * confirmed the applicant is an adult, so the separate age gate is satisfied
 * by the same evidence.
 */
export const startVerification = async (
  userId,
  { providerName = 'simulated', type = 'ID_DOCUMENT' } = {},
  { dbp = prisma, provider } = {}
) => {
  provider = provider ?? createKycProvider(providerName);

  if (!VERIFICATION_CHECK_TYPES.includes(type)) {
    throw new InvalidVerificationTypeError();
  }

  const user = await dbp.user.findUnique({
    where: { id: userId },
    select: { id: true, kycStatus: true }
  });
  if (!user) throw new KycRequiredError('Account not found');
  if (user.kycStatus === 'VERIFIED') throw new KycAlreadyVerifiedError();

  const inFlight = await dbp.verificationCase.findFirst({
    where: {
      userId,
      status: { in: ['STARTED', 'PENDING', 'UNDER_REVIEW'] }
    }
  });
  if (inFlight) throw new KycInProgressError();

  const caseRow = await dbp.verificationCase.create({
    data: { userId, status: 'STARTED', provider: providerName }
  });
  const check = await dbp.verificationCheck.create({
    data: { caseId: caseRow.id, type }
  });

  let result;
  try {
    const started = await provider.start(userId, { type });
    result = await provider.getResult(started.providerReference);
  } catch (err) {
    if (err instanceof KycProviderError || err?.name === 'KycProviderError') {
      await dbp.verificationCheck.update({
        where: { id: check.id },
        data: { status: 'FAILED', providerResponse: { error: err.message } }
      });
      await dbp.verificationCase.update({
        where: { id: caseRow.id },
        data: { status: 'REJECTED' }
      });
      throw new KycRejectedError('The verification provider could not complete the check.');
    }
    throw err;
  }

  if (result?.status === 'PASSED') {
    await dbp.verificationCheck.update({
      where: { id: check.id },
      data: {
        status: 'PASSED',
        verifiedAt: new Date(),
        providerResponse: result
      }
    });
    await dbp.verificationCase.update({
      where: { id: caseRow.id },
      data: { status: 'VERIFIED' }
    });
    await dbp.user.update({
      where: { id: userId },
      data: { kycStatus: 'VERIFIED', ageVerified: true }
    });
    logger.info({ userId, caseId: caseRow.id, checkId: check.id }, 'KYC verified via provider');
    return { status: 'VERIFIED', caseId: caseRow.id, checkId: check.id };
  }

  await dbp.verificationCheck.update({
    where: { id: check.id },
    data: { status: 'FAILED', providerResponse: result }
  });
  await dbp.verificationCase.update({
    where: { id: caseRow.id },
    data: { status: 'REJECTED' }
  });
  logger.warn({ userId, caseId: caseRow.id }, 'KYC rejected by provider');
  throw new KycRejectedError();
};