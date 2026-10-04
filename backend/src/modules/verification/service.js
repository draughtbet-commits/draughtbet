import prisma from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { KycRequiredError } from '../../services/eligibilityService.js';
import {
  createKycProvider,
  ASYNC_KYC_PROVIDERS,
  KycProviderError,
} from './providerAdapter.js';

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
  // A standing verification outranks whatever the newest attempt says. Only the
  // provider result that granted it, or an explicit revocation, may undo it --
  // so a stale pending or rejected attempt must never be reported as the
  // current state, which would tell a verified player they are not verified
  // while the server keeps honouring their verification.
  const isVerified = user.kycStatus === 'VERIFIED';
  return {
    kycStatus: user.kycStatus,
    // A ban restricts activity, not access: the user still authenticates and
    // reads this payload so the client can show a dismissible restricted
    // banner instead of silently failing every action later.
    isBanned: user.isBanned ?? false,
    case: latest
      ? {
          id: latest.id,
          status: isVerified ? 'VERIFIED' : latest.status,
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
        // Newest *attempt*. Ordering by updatedAt would let a late webhook on an
        // old case present it as the current one.
        orderBy: { createdAt: 'desc' },
        take: 1,
        include: { checks: true }
      }
    }
  });
  if (!user) throw new KycRequiredError('Account not found');
  return kycStatusView(user);
};

/// How long an unsettled asynchronous attempt is still worth waiting on.
///
/// A provider can drop a webhook, and the player has no way to unstick it, so an
/// attempt that has gone quiet this long is retired. Generous enough to cover a
/// slow review, short enough that a player is never locked out for long.
const VERIFICATION_ATTEMPT_TTL_MS = Number(process.env.KYC_ATTEMPT_TTL_MS || 24 * 60 * 60 * 1000);

/// Statuses that mean the provider has not finished deciding.
const IN_FLIGHT_CASE_STATUSES = ['STARTED', 'PENDING', 'UNDER_REVIEW'];

/// Settling one of these is final for a provider verdict.
const TERMINAL_CASE_STATUSES = ['VERIFIED', 'REJECTED', 'EXPIRED'];

/**
 * Projects a provider verdict onto the VerificationCase, its checks and the
 * User.kycStatus compatibility column.
 *
 * This is the single place a provider result becomes a decision, so the inline
 * (synchronous provider) path and the webhook path cannot drift apart.
 *
 * The whole projection runs in one transaction, because the case status and
 * User.kycStatus are not two independent facts: kycStatus is what the
 * withdrawal gate reads, so a case recorded as VERIFIED beside a user still
 * marked NONE would show the player "verified" while every withdrawal was
 * refused, and the reverse would grant withdrawal rights nobody granted.
 *
 * The transition is claimed with a conditional update rather than a
 * read-then-write. Two deliveries of the same verification can arrive together
 * -- "ongoing" then "completed" are different payloads with different dedupe
 * keys -- and only the delivery that actually moves the case out of a pending
 * state is allowed to write a verdict. That is what makes re-applying a
 * delivery harmless, and it is why the caller can safely retry one.
 *
 * Returns the case id, or null when no case owns this provider reference (an
 * unknown reference is not an error — the provider may have been handed one by a
 * different system).
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

  if (TERMINAL_CASE_STATUSES.includes(caseRow.status)) {
    logger.info(
      { providerReference, caseStatus: caseRow.status, resultStatus: result.status },
      'Ignoring provider result for an already-settled case'
    );
    return caseRow.id;
  }

  const verifiedAt = new Date();
  const response = sanitizeProviderResponse(result);
  const settledStatus = result.status === 'PASSED' ? 'VERIFIED' : 'REJECTED';

  // Only object-shaped entries with a type we can actually store are per-check
  // verdicts. An unknown type is dropped rather than written: the column is a
  // database enum, and one unrecognised value would abort the transaction and
  // with it the whole verdict.
  const providerChecks = Array.isArray(result.checks)
    ? result.checks.filter((c) => c && typeof c === 'object' && VERIFICATION_CHECK_TYPES.includes(c.type))
    : [];

  return dbp.$transaction(async (tx) => {
    // Claim the transition. Exactly one concurrent delivery can match, so a
    // duplicate or out-of-order verdict cannot overwrite the settled state.
    const { count } = await tx.verificationCase.updateMany({
      where: { id: caseRow.id, status: { in: IN_FLIGHT_CASE_STATUSES } },
      data: { status: settledStatus }
    });
    if (count !== 1) {
      logger.info(
        { providerReference, caseId: caseRow.id },
        'Verification case was settled by another delivery; ignoring this one'
      );
      return caseRow.id;
    }

    if (providerChecks.length) {
      for (const pc of providerChecks) {
        const existing = caseRow.checks.find((c) => c.type === pc.type);
        if (existing) {
          await tx.verificationCheck.update({
            where: { id: existing.id },
            data: {
              status: pc.passed ? 'PASSED' : 'FAILED',
              verifiedAt,
              providerResponse: response
            }
          });
        } else {
          await tx.verificationCheck.create({
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
      // No breakdown: the single check created at start carries the verdict.
      const target = caseRow.checks[0];
      if (target) {
        await tx.verificationCheck.update({
          where: { id: target.id },
          data: {
            status: settledStatus === 'VERIFIED' ? 'PASSED' : 'FAILED',
            verifiedAt,
            providerResponse: response
          }
        });
      }
    }

    if (settledStatus === 'VERIFIED') {
      // The provider has confirmed the applicant is an adult, so the same
      // evidence satisfies the separate age gate.
      await tx.user.update({
        where: { id: caseRow.userId },
        data: { kycStatus: 'VERIFIED', ageVerified: true }
      });
      logger.info({ userId: caseRow.userId, caseId: caseRow.id }, 'KYC verified via provider');
    } else {
      // Deliberately does not touch kycStatus: a rejection says nothing about
      // whether an earlier verification still stands, and clearing it here
      // would let a retried attempt revoke a player who is already verified.
      logger.warn({ userId: caseRow.userId, caseId: caseRow.id }, 'KYC rejected by provider');
    }

    return caseRow.id;
  });
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
  { providerName = process.env.KYC_PROVIDER, type = 'ID_DOCUMENT' } = {},
  { dbp = prisma, provider } = {}
) => {
  // No implicit default. The simulated provider approves every applicant, so
  // falling back to it when the variable is missing would hand out verified
  // accounts -- and withdrawal rights -- on any deployment that forgot to set it.
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

  const isAsync = provider.mode === 'async';

  // The reference must be persisted before any result can arrive: for an async
  // provider the webhook that carries the verdict knows only this value.
  let caseRow;
  let check;
  let started;

  // The guard and the insert are one serialisable transaction. Checked
  // separately they race: two requests in the same second both see no live case
  // and both create one, leaving a second attempt that no webhook will ever
  // match and that then blocks every later retry.
  try {
    await dbp.$transaction(
      async (tx) => {
        const inFlight = await tx.verificationCase.findFirst({
          where: {
            userId,
            status: { in: IN_FLIGHT_CASE_STATUSES },
            // A live attempt stops counting once it has expired. Without this a
            // dropped webhook would lock the player out of starting again, and
            // so out of withdrawals, with no way back short of an admin.
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
          }
        });
        if (inFlight) throw new KycInProgressError();

        started = await provider.start(userId, { type });
        caseRow = await tx.verificationCase.create({
          data: {
            userId,
            status: isAsync ? 'PENDING' : 'STARTED',
            provider: started.provider ?? providerName,
            providerReference: started.providerReference ?? null,
            expiresAt: isAsync
              ? new Date(Date.now() + VERIFICATION_ATTEMPT_TTL_MS)
              : null
          }
        });
        check = await tx.verificationCheck.create({
          data: { caseId: caseRow.id, type }
        });
      },
      { isolationLevel: 'Serializable' }
    );
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
      // Mobile clients launch the provider's native SDK by widget id rather
      // than opening a URL, so both forms are returned.
      widgetId: started?.widgetId ?? null,
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
/**
 * Retires verification attempts that will never be settled.
 *
 * A provider can drop a webhook, and a player who never completes the widget
 * leaves one behind. Either way the attempt sits in a pending status forever,
 * the in-flight guard then refuses every new attempt, and because kycStatus
 * gates withdrawals the player is locked out of their own money with no route
 * back. Expiring it is what makes the flow recoverable.
 *
 * Before giving up we ask the provider directly. The webhook is the fast path,
 * not the only one, so a delivery that was merely lost is still honoured rather
 * than thrown away.
 *
 * Idempotent and safe to re-run: the update only touches rows still pending, so
 * a concurrent verdict already claimed the transition first and is left alone.
 */
export const expireStaleVerificationCases = async ({
  dbp = prisma,
  providerFactory = createKycProvider
} = {}) => {
  const stale = await dbp.verificationCase.findMany({
    where: {
      status: { in: IN_FLIGHT_CASE_STATUSES },
      expiresAt: { lte: new Date() }
    },
    select: { id: true, provider: true, providerReference: true },
    take: 100
  });
  if (!stale.length) return { expired: 0, recovered: 0 };

  let expired = 0;
  let recovered = 0;

  for (const row of stale) {
    // Ask the provider *before* retiring the attempt. Once this marks the case
    // EXPIRED the verdict can no longer be applied, so a provider that did
    // answer in time would be thrown away and the player would have to start
    // over. Restricted to asynchronous providers on purpose: the simulated one
    // answers PASSED to anything and would hand out withdrawal rights to a
    // player who was never checked.
    if (row.providerReference && ASYNC_KYC_PROVIDERS.includes(row.provider)) {
      try {
        const result = await providerFactory(row.provider).getResult(row.providerReference);
        if (result?.status && result.status !== 'PENDING') {
          await applyVerificationResult(
            { providerReference: row.providerReference, result },
            { dbp }
          );
          recovered += 1;
          continue;
        }
      } catch (err) {
        // The provider being unreachable must not stop the sweep; the attempt is
        // still retired below, which is the outcome that unblocks the player.
        logger.warn({ err, caseId: row.id }, 'Could not recover a stale verification attempt');
      }
    }

    // A settled case is never expired, whatever the clock says.
    const { count } = await dbp.verificationCase.updateMany({
      where: { id: row.id, status: { in: IN_FLIGHT_CASE_STATUSES } },
      data: { status: 'EXPIRED' }
    });
    if (count === 1) expired += 1;
  }

  if (expired) logger.info({ expired, recovered }, 'Expired stale verification attempts');
  return { expired, recovered };
};
