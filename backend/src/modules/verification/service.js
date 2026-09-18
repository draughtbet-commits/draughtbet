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

// ---------------------------------------------------------------------------
// Admin KYC review (RISK_COMPLIANCE / SUPER_ADMIN)
// ---------------------------------------------------------------------------

export class VerificationCaseNotFoundError extends Error {
  constructor(message = 'Verification case not found') {
    super(message);
    this.name = 'VerificationCaseNotFoundError';
  }
}

export class VerificationCaseNotReviewableError extends Error {
  constructor(message = 'Verification case is not reviewable in its current state') {
    super(message);
    this.name = 'VerificationCaseNotReviewableError';
  }
}

// A case an operator may still close by hand. VERIFIED is terminal and can
// never be re-reviewed.
const REVIEWABLE_CASE_STATUSES = ['STARTED', 'PENDING', 'UNDER_REVIEW', 'REJECTED', 'EXPIRED'];

export const listVerificationCases = async ({
  page = 1,
  limit = 20,
  status = null,
  dbp = prisma
} = {}) => {
  const where = status ? { status } : {};
  const skip = (page - 1) * limit;
  const [rows, total] = await Promise.all([
    dbp.verificationCase.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip,
      take: limit,
      include: {
        checks: { orderBy: { createdAt: 'asc' } },
        user: { select: { id: true, email: true, fullName: true, kycStatus: true } }
      }
    }),
    dbp.verificationCase.count({ where })
  ]);
  return {
    cases: rows,
    total,
    page,
    totalPages: Math.ceil(total / limit)
  };
};

/**
 * Admin approve (overrides a provider rejection / manual review). Flips case +
 * open checks to VERIFIED and projects the pass onto the user, attributed to
 * the reviewing admin in case metadata.
 */
export const approveVerificationCase = async (
  caseId,
  { adminId = null, note = null, dbp = prisma } = {}
) => {
  return dbp.$transaction(async (tx) => {
    const vc = await tx.verificationCase.findUnique({ where: { id: caseId } });
    if (!vc) throw new VerificationCaseNotFoundError();
    if (vc.status === 'VERIFIED') {
      logger.info({ caseId, adminId }, 'KYC approve replayed on already-verified case');
      return { case: vc, replayed: true };
    }
    if (!REVIEWABLE_CASE_STATUSES.includes(vc.status)) {
      throw new VerificationCaseNotReviewableError();
    }

    const now = new Date();
    await tx.verificationCheck.updateMany({
      where: { caseId, status: { in: ['PENDING', 'FAILED'] } },
      data: { status: 'PASSED', verifiedAt: now }
    });
    const updated = await tx.verificationCase.update({
      where: { id: caseId },
      data: {
        status: 'VERIFIED',
        metadata: { ...(vc.metadata ?? {}), reviewedBy: adminId, reviewedAt: now.toISOString(), note }
      }
    });
    await tx.user.update({
      where: { id: vc.userId },
      data: { kycStatus: 'VERIFIED', ageVerified: true }
    });
    logger.info({ caseId, adminId, userId: vc.userId }, 'KYC case approved by admin');
    return { case: updated, replayed: false };
  });
};

/**
 * Admin reject. Only still-open checks are failed (provider pass provenance is
 * never rewritten); the case carries the reviewer + reason. A later case still
 * decides the user's KYC status.
 */
export const rejectVerificationCase = async (
  caseId,
  { adminId = null, reason = null, dbp = prisma } = {}
) => {
  return dbp.$transaction(async (tx) => {
    const vc = await tx.verificationCase.findUnique({ where: { id: caseId } });
    if (!vc) throw new VerificationCaseNotFoundError();
    if (vc.status === 'REJECTED') {
      return { case: vc, replayed: true };
    }
    if (!REVIEWABLE_CASE_STATUSES.includes(vc.status) && vc.status !== 'VERIFIED') {
      throw new VerificationCaseNotReviewableError();
    }
    if (vc.status === 'VERIFIED' && !(process.env.ADMIN_KYC_OVERRIDE_VERIFIED === 'true')) {
      throw new VerificationCaseNotReviewableError('A verified case cannot be rejected');
    }

    const now = new Date();
    await tx.verificationCheck.updateMany({
      where: { caseId, status: { in: ['PENDING'] } },
      data: { status: 'FAILED' }
    });
    const updated = await tx.verificationCase.update({
      where: { id: caseId },
      data: {
        status: 'REJECTED',
        metadata: { ...(vc.metadata ?? {}), reviewedBy: adminId, reviewedAt: now.toISOString(), reason }
      }
    });
    await tx.user.update({
      where: { id: vc.userId },
      data: { kycStatus: 'PENDING' }
    });
    logger.info({ caseId, adminId, userId: vc.userId, reason }, 'KYC case rejected by admin');
    return { case: updated, replayed: false };
  });
};