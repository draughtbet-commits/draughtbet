import crypto from 'crypto';
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

// ---------------------------------------------------------------------------
// PII guardrails. Verification provider payloads can carry the most
// sensitive data in the system — ID numbers, addresses, document/photos. We
// persist only a curated projection and never echo documents or PII anywhere.
// ---------------------------------------------------------------------------

// Keep only verdict-shaped keys; anything else that could hold PII is dropped.
const ALLOWED_RESULT_KEYS = new Set([
  'status',
  'providerReference',
  'reference',
  'verdict',
  'checks',
  'passedChecks',
  'failedChecks',
  'score',
  'message',
  'provider'
]);

// Value-level sniffer: URLs, data/blob URIs, long base64 blobs, email-shaped
// strings never get persisted even if a provider recurses one under a safe key.
const PII_VALUE_SNIFFER = /^(https?:|data:|blob:)\S+|^[A-Za-z0-9+/=]{40,}$|^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const sanitizeProviderResponse = (result) => {
  if (!result || typeof result !== 'object') return null;
  if (Array.isArray(result)) {
    return result.map((item) => sanitizeProviderResponse(item)).filter((item) => item !== null);
  }
  const out = {};
  for (const [key, value] of Object.entries(result)) {
    if (!ALLOWED_RESULT_KEYS.has(key)) continue;
    if (typeof value === 'string' && PII_VALUE_SNIFFER.test(value.trim())) continue;
    if (Array.isArray(value)) {
      const safe = value
        .map((item) => (typeof item === 'string' ? item : sanitizeProviderResponse(item)))
        .filter((item) => item !== null);
      if (safe.length) out[key] = safe;
    } else if (value && typeof value === 'object') {
      const nested = sanitizeProviderResponse(value);
      if (nested !== null) out[key] = nested;
    } else {
      out[key] = value;
    }
  }
  return out;
};

export const maskEmail = (email) => {
  if (!email || !email.includes('@')) return email;
  const [local, domain] = email.split('@');
  const head = local.slice(0, Math.min(3, local.length));
  return `${head}${'*'.repeat(Math.max(1, local.length - 3))}@${domain}`;
};

export const maskName = (name) => {
  if (!name) return name;
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 1) return `${parts[0].slice(0, 1)}***`;
  return `${parts[0]} ${parts[1].slice(0, 1)}.`;
};

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
        providerResponse: sanitizeProviderResponse(result)
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
    data: { status: 'FAILED', providerResponse: sanitizeProviderResponse(result) }
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
const REVIEWABLE_CASE_STATUSES = ['REQUIRED', 'STARTED', 'PENDING', 'UNDER_REVIEW', 'REJECTED', 'EXPIRED'];

export const listVerificationCases = async ({
  page = 1,
  limit = 20,
  status = null,
  search = null,
  sortBy = 'updatedAt',
  order = 'desc',
  dbp = prisma
} = {}) => {
  const where = status ? { status } : {};
  if (search && typeof search === 'string' && search.trim() !== '') {
    const term = search.trim();
    where.OR = [
      { id: { contains: term, mode: 'insensitive' } },
      { userId: { contains: term, mode: 'insensitive' } },
      { user: { email: { contains: term, mode: 'insensitive' } } },
      { user: { username: { contains: term, mode: 'insensitive' } } },
      { user: { fullName: { contains: term, mode: 'insensitive' } } }
    ];
  }
  const validSortFields = ['createdAt', 'updatedAt', 'status'];
  const sortField = validSortFields.includes(sortBy) ? sortBy : 'updatedAt';
  const sortOrder = order === 'asc' ? 'asc' : 'desc';
  const skip = (page - 1) * limit;
  const [rows, total] = await Promise.all([
    dbp.verificationCase.findMany({
      where,
      orderBy: { [sortField]: sortOrder },
      skip,
      take: limit,
      select: {
        id: true,
        userId: true,
        status: true,
        provider: true,
        metadata: true,
        createdAt: true,
        updatedAt: true,
        checks: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, type: true, status: true, verifiedAt: true }
        },
        user: {
          select: {
            id: true,
            email: true,
            username: true,
            fullName: true,
            kycStatus: true,
            ageVerified: true,
            countryCode: true
          }
        }
      }
    }),
    dbp.verificationCase.count({ where })
  ]);
  const cases = rows.map((row) => ({
    ...row,
    user: row.user
      ? {
          ...row.user,
          // Never surface raw PII in an admin list view.
          email: maskEmail(row.user.email),
          fullName: maskName(row.user.fullName)
        }
      : row.user
  }));
  return {
    cases,
    total,
    page,
    totalPages: Math.ceil(total / limit)
  };
};

/**
 * Detailed KYC application view for authorized compliance reviewers.
 * Never returns raw private document URLs or permanent storage credentials.
 */
export const getVerificationCaseDetail = async (caseId, { dbp = prisma } = {}) => {
  const row = await dbp.verificationCase.findUnique({
    where: { id: caseId },
    include: {
      checks: {
        orderBy: { createdAt: 'asc' }
      },
      user: {
        select: {
          id: true,
          email: true,
          username: true,
          fullName: true,
          phone: true,
          kycStatus: true,
          ageVerified: true,
          dateOfBirth: true,
          countryCode: true,
          isBanned: true,
          createdAt: true,
          eligibility: true
        }
      }
    }
  });
  if (!row) throw new VerificationCaseNotFoundError();

  const [previousCases, auditHistory] = await Promise.all([
    dbp.verificationCase?.findMany
      ? dbp.verificationCase.findMany({
          where: { userId: row.userId },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: {
            id: true,
            status: true,
            provider: true,
            metadata: true,
            createdAt: true,
            updatedAt: true
          }
        })
      : Promise.resolve([]),
    dbp.adminAuditLog?.findMany
      ? dbp.adminAuditLog.findMany({
          where: {
            OR: [
              { targetType: 'verification-case', targetId: caseId },
              { targetId: caseId }
            ]
          },
          orderBy: { createdAt: 'desc' },
          take: 25
        })
      : Promise.resolve([])
  ]);

  const sanitizedChecks = (row.checks ?? []).map((c) => ({
    id: c.id,
    caseId: c.caseId,
    type: c.type,
    status: c.status,
    verifiedAt: c.verifiedAt,
    createdAt: c.createdAt,
    providerResponse: sanitizeProviderResponse(c.providerResponse)
  }));

  return {
    verificationCase: {
      id: row.id,
      userId: row.userId,
      status: row.status,
      provider: row.provider,
      metadata: row.metadata,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      user: row.user,
      checks: sanitizedChecks,
      statusHistory: previousCases,
      auditHistory
    }
  };
};

/**
 * Generates a short-lived signed access envelope for inspecting a KYC check
 * document without ever exposing permanent object storage URLs or credentials.
 */
export const generateVerificationDocumentAccess = async (
  caseId,
  { checkId = null, adminId = null, dbp = prisma } = {}
) => {
  const row = await dbp.verificationCase.findUnique({
    where: { id: caseId },
    include: { checks: true }
  });
  if (!row) throw new VerificationCaseNotFoundError();

  const targetCheck = checkId
    ? (row.checks ?? []).find((c) => c.id === checkId)
    : (row.checks ?? [])[0] ?? null;

  if (checkId && !targetCheck) {
    const err = new Error('Verification check not found on this case');
    err.name = 'VerificationCaseNotFoundError';
    throw err;
  }

  const now = new Date();
  const expiresInSeconds = 120;
  const expiresAt = new Date(now.getTime() + expiresInSeconds * 1000).toISOString();
  const signingSecret = process.env.JWT_SECRET || 'kyc-ephemeral-signing-key';
  const payloadString = `${caseId}:${targetCheck?.id ?? 'case'}:${adminId ?? 'admin'}:${expiresAt}`;
  const signature = crypto
    .createHmac('sha256', signingSecret)
    .update(payloadString)
    .digest('hex');

  return {
    access: {
      caseId: row.id,
      checkId: targetCheck?.id ?? null,
      checkType: targetCheck?.type ?? 'ID_DOCUMENT',
      checkStatus: targetCheck?.status ?? row.status,
      provider: row.provider || 'simulated',
      signedToken: `kyc_sig_${signature.slice(0, 32)}`,
      expiresAt,
      expiresInSeconds,
      watermark: `CONFIDENTIAL · VIEWED BY ${adminId ?? 'ADMIN'} · ${now.toISOString()}`,
      sanitizedVerdict: sanitizeProviderResponse(targetCheck?.providerResponse) ?? {
        status: targetCheck?.status ?? row.status,
        provider: row.provider || 'simulated',
        verdict: targetCheck?.status === 'PASSED' ? 'MATCH_CONFIRMED' : 'MANUAL_REVIEW_REQUIRED'
      }
    }
  };
};

/**
 * Admin request additional information. Transitions a reviewable case to
 * REQUIRED and records the operator's request in case metadata and user status.
 */
export const requestAdditionalKycInfo = async (
  caseId,
  { adminId = null, reason = null, dbp = prisma } = {}
) => {
  return dbp.$transaction(async (tx) => {
    const vc = await tx.verificationCase.findUnique({ where: { id: caseId } });
    if (!vc) throw new VerificationCaseNotFoundError();
    if (!REVIEWABLE_CASE_STATUSES.includes(vc.status)) {
      throw new VerificationCaseNotReviewableError(
        'Cannot request additional information on a verified or closed case'
      );
    }

    const now = new Date();
    const prevHistory = Array.isArray(vc.metadata?.decisionHistory)
      ? vc.metadata.decisionHistory
      : [];
    const entry = {
      action: 'REQUEST_ADDITIONAL_INFO',
      reviewedBy: adminId,
      reviewedAt: now.toISOString(),
      reason: reason || 'Additional identity verification information required'
    };

    const updated = await tx.verificationCase.update({
      where: { id: caseId },
      data: {
        status: 'REQUIRED',
        metadata: {
          ...(vc.metadata ?? {}),
          reviewedBy: adminId,
          reviewedAt: now.toISOString(),
          infoRequestedReason: entry.reason,
          decisionHistory: [...prevHistory, entry]
        }
      }
    });
    await tx.user.update({
      where: { id: vc.userId },
      data: { kycStatus: 'PENDING' }
    });
    logger.info({ caseId, adminId, userId: vc.userId, reason }, 'Additional KYC info requested by admin');
    return { case: updated, replayed: false };
  });
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