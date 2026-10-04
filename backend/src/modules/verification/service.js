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
    // A ban restricts activity, not access: the user still authenticates and
    // reads this payload so the client can show a dismissible restricted
    // banner instead of silently failing every action later.
    isBanned: user.isBanned ?? false,
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
      isBanned: true,
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
 * Projects a provider verdict onto the VerificationCase, its checks and the
 * User.kycStatus compatibility column.
 *
 * This is the single place a provider result becomes a decision, so the inline
 * (synchronous provider) path and the webhook path cannot drift apart.
 *
 * Terminal case statuses are sticky. A replayed or out-of-order delivery must
 * never walk a VERIFIED case back to REJECTED. Admin review is a deliberate
 * override and lives in approve/rejectVerificationCase, which is unaffected.
 *
 * Returns the case id, or null when no case owns this provider reference (an
 * unknown reference is not an error — the provider may have been handed one by
 * a different system).
 */
export const applyVerificationResult = async (
  { providerReference, result, caseRow: knownCase },
  { dbp = prisma } = {}
) => {
  if (!providerReference || !result) return null;

  // The inline path already holds the row it just created, so it passes it in
  // and skips the lookup the webhook path needs.
  const caseRow =
    knownCase ??
    (await dbp.verificationCase.findUnique({
      where: { providerReference },
      include: { checks: true }
    }));
  if (!caseRow) {
    logger.warn({ providerReference }, 'Verification result for an unknown provider reference');
    return null;
  }

  if (caseRow.status === 'VERIFIED' || caseRow.status === 'REJECTED') {
    logger.info(
      { providerReference, caseStatus: caseRow.status, resultStatus: result.status },
      'Ignoring provider result for an already-settled case'
    );
    return caseRow.id;
  }

  const verifiedAt = new Date();
  const response = sanitizeProviderResponse(result);

  // Only object-shaped entries are per-check verdicts. A provider may instead
  // report a bare list of the checks it ran (the simulated one does), which
  // carries no verdict of its own — the overall result decides that case.
  const providerChecks = Array.isArray(result.checks)
    ? result.checks.filter((c) => c && typeof c === 'object' && c.type)
    : [];

  if (providerChecks.length) {
    for (const pc of providerChecks) {
      const existing = caseRow.checks.find((c) => c.type === pc.type);
      if (existing) {
        await dbp.verificationCheck.update({
          where: { id: existing.id },
          data: {
            status: pc.passed ? 'PASSED' : 'FAILED',
            verifiedAt,
            providerResponse: response
          }
        });
      } else {
        await dbp.verificationCheck.create({
          data: {
            caseId: caseRow.id,
            type: pc.type,
            status: pc.passed ? 'PASSED' : 'FAILED',
            verifiedAt,
            providerResponse: response
          }
        });
      }
    }
  } else {
    const target = caseRow.checks[0];
    if (target) {
      await dbp.verificationCheck.update({
        where: { id: target.id },
        data: {
          status: result.status === 'PASSED' ? 'PASSED' : 'FAILED',
          verifiedAt,
          providerResponse: response
        }
      });
    }
  }

  if (result.status === 'PASSED') {
    await dbp.verificationCase.update({
      where: { id: caseRow.id },
      data: { status: 'VERIFIED' }
    });
    // The provider has confirmed the applicant is an adult, so the same
    // evidence satisfies the separate age gate.
    await dbp.user.update({
      where: { id: caseRow.userId },
      data: { kycStatus: 'VERIFIED', ageVerified: true }
    });
    logger.info({ userId: caseRow.userId, caseId: caseRow.id }, 'KYC verified via provider');
    return caseRow.id;
  }

  await dbp.verificationCase.update({
    where: { id: caseRow.id },
    data: { status: 'REJECTED' }
  });
  logger.warn({ userId: caseRow.userId, caseId: caseRow.id }, 'KYC rejected by provider');
  return caseRow.id;
};

/**
 * Runs a verification pass for the player through the injected provider.
 *
 * How the result arrives depends on the provider:
 *
 * - A synchronous provider (the simulated one) answers inline, so the verdict
 *   is projected here and returned.
 * - An asynchronous provider (Dojah) has the player complete the check on the
 *   provider's own widget and decides later. The case is persisted as PENDING
 *   along with the reference that identifies it, and the verdict arrives on a
 *   webhook that is matched by that reference. Returning PENDING is what keeps
 *   a request timeout from looking like a rejection.
 */
export const startVerification = async (
  userId,
  { providerName = process.env.KYC_PROVIDER || 'simulated', type = 'ID_DOCUMENT' } = {},
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

  const isAsync = provider.mode === 'async';

  // The reference must be persisted before any result can arrive: for an async
  // provider the webhook that carries the verdict knows only this value.
  let caseRow;
  let check;
  let started;
  try {
    started = await provider.start(userId, { type });
    caseRow = await dbp.verificationCase.create({
      data: {
        userId,
        status: isAsync ? 'PENDING' : 'STARTED',
        provider: started.provider ?? providerName,
        providerReference: started.providerReference ?? null
      }
    });
    check = await dbp.verificationCheck.create({
      data: { caseId: caseRow.id, type }
    });
  } catch (err) {
    if (err instanceof KycProviderError || err?.name === 'KycProviderError') {
      throw new KycRejectedError('The verification provider could not complete the check.');
    }
    throw err;
  }

  if (isAsync) {
    logger.info(
      { userId, caseId: caseRow.id, provider: providerName },
      'KYC started; awaiting provider webhook'
    );
    return {
      status: 'PENDING',
      caseId: caseRow.id,
      checkId: check.id,
      providerReference: caseRow.providerReference,
      widgetUrl: started?.widgetUrl ?? null
    };
  }

  let result;
  try {
    result = await provider.getResult(caseRow.providerReference);
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
    await applyVerificationResult(
      { providerReference: caseRow.providerReference, result, caseRow: { ...caseRow, checks: [{ id: check.id, type }] } },
      { dbp }
    );
    return { status: 'VERIFIED', caseId: caseRow.id, checkId: check.id };
  }

  if (result?.status === 'PENDING') {
    // A synchronous provider that has not settled yet: leave the case open
    // rather than recording a verdict nobody reached.
    await dbp.verificationCase.update({
      where: { id: caseRow.id },
      data: { status: 'PENDING' }
    });
    return { status: 'PENDING', caseId: caseRow.id, checkId: check.id };
  }

  await applyVerificationResult(
      { providerReference: caseRow.providerReference, result, caseRow: { ...caseRow, checks: [{ id: check.id, type }] } },
      { dbp }
    );
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
      select: {
        id: true,
        status: true,
        provider: true,
        metadata: true,
        createdAt: true,
        updatedAt: true,
        checks: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, type: true, status: true, verifiedAt: true }
        },
        user: { select: { id: true, email: true, fullName: true, kycStatus: true } }
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

// ---------------------------------------------------------------------------
// KycDocument — producer-side document evidence attached to an in-flight
// verification case. Rows are private storage references (objectKey) with a
// sha256 for integrity; content/PII is never echoed to clients or admin.
// ---------------------------------------------------------------------------

export const KYC_DOCUMENT_TYPES = Object.freeze([
  'national_id',
  'passport',
  'driver_license',
  'proof_of_address',
  'selfie',
  'nin_slip'
]);

export class KycDocumentError extends Error {
  constructor(message = 'Document could not be attached') {
    super(message);
    this.name = 'KycDocumentError';
  }
}

const SHA256_RE = /^[0-9a-f]{64}$/;

const toDocumentView = (row) => ({
  id: row.id,
  documentType: row.documentType,
  objectKey: row.objectKey,
  mimeType: row.mimeType,
  sizeBytes: row.sizeBytes.toString(),
  sha256: row.sha256,
  uploadedAt: row.uploadedAt,
  deleted: !!row.deletedAt
});

const inFlightCaseQuery = (userId) => ({
  userId,
  status: { in: ['STARTED', 'PENDING', 'UNDER_REVIEW'] }
});

/**
 * Attaches a document reference to the player's current in-flight case.
 * Re-attaching the same sha256/objectKey is idempotent and returns the first row.
 */
export const attachDocument = async (
  userId,
  { documentType, objectKey, mimeType, sizeBytes, sha256 },
  { dbp = prisma } = {}
) => {
  if (!KYC_DOCUMENT_TYPES.includes(documentType)) {
    throw new InvalidVerificationTypeError('Unsupported document type');
  }
  if (typeof objectKey !== 'string' || !objectKey.trim()) {
    throw new KycDocumentError('Missing document reference');
  }
  if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) {
    throw new KycDocumentError('Invalid document checksum');
  }
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
    throw new KycDocumentError('Invalid document size');
  }

  const existing = await dbp.kycDocument.findUnique({ where: { objectKey } });
  if (existing && existing.userId === userId && existing.sha256 === sha256 && !existing.deletedAt) {
    return toDocumentView(existing);
  }

  const active = await dbp.verificationCase.findFirst({
    where: inFlightCaseQuery(userId),
    orderBy: { createdAt: 'desc' }
  });
  if (!active) throw new KycDocumentError('No verification case in progress');

  const row = await dbp.kycDocument.create({
    data: {
      userId,
      verificationCaseId: active.id,
      documentType,
      objectKey,
      mimeType: typeof mimeType === 'string' && mimeType ? mimeType : 'application/octet-stream',
      sizeBytes: BigInt(sizeBytes),
      sha256
    }
  });
  logger.info({ userId, caseId: active.id, documentType }, 'KYC document attached');
  return toDocumentView(row);
};

/** The player's own current (non-revoked) document evidence. */
export const listMyDocuments = async (userId, { dbp = prisma } = {}) => {
  const rows = await dbp.kycDocument.findMany({
    where: { userId, deletedAt: null },
    orderBy: { uploadedAt: 'desc' }
  });
  return rows.map(toDocumentView);
};

/** Soft-revokes a document the player owns. */
export const revokeDocument = async (userId, documentId, { dbp = prisma } = {}) => {
  const { count } = await dbp.kycDocument.updateMany({
    where: { id: documentId, userId, deletedAt: null },
    data: { deletedAt: new Date() }
  });
  if (count === 0) throw new KycDocumentError('Document not found');
  return { revoked: true };
};

/**
 * Admin evidence read: every document ever attached to a case (revoked ones
 * are flagged), with case context. Content is never returned.
 */
export const listCaseDocuments = async (caseId, { dbp = prisma } = {}) => {
  const vc = await dbp.verificationCase.findUnique({ where: { id: caseId } });
  if (!vc) throw new VerificationCaseNotFoundError();
  const rows = await dbp.kycDocument.findMany({
    where: { verificationCaseId: caseId },
    orderBy: { uploadedAt: 'asc' }
  });
  return { case: { id: vc.id, userId: vc.userId, status: vc.status }, documents: rows.map(toDocumentView) };
};