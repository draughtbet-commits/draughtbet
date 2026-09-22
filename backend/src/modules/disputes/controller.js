import express from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requireIdempotencyKey } from '../../middleware/idempotency.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { requirePermission, hasPermission } from '../rbac/service.js';
import { auditFromRequest } from '../audit/service.js';
import { parsePagination } from '../../utils/pagination.js';
import { parseMinorUnits } from '../wallet/service.js';
import {
  DISPUTE_STATUS_LIST,
  DISPUTE_EVIDENCE_TYPES,
  listDisputes,
  addDisputeEvidence,
  raiseDispute,
  decideDispute,
  DisputeCaseNotFoundError,
  DisputeCaseNotReviewableError,
  DisputeNotEligibleError,
  DisputeWindowExpiredError,
  DuplicateDisputeError,
  DisputeAdjustmentError
} from './service.js';
import { InsufficientFundsError, InvalidAmountError } from '../../services/ledgerService.js';

// Dispute review surface (SUPPORT / SUPER_ADMIN). Mounted inside the admin
// router AFTER requireAuth + requireAdminMfa + the idempotency gate: auth, MFA
// and POST Idempotency-Key handling are inherited from the parent.

export const disputeAdminRouter = express.Router();

disputeAdminRouter.get('/disputes', requirePermission(PERMISSIONS.DISPUTES_MANAGE), async (req, res, next) => {
  try {
    const parsed = parsePagination(req.query);
    if (!parsed.ok) return res.status(400).json({ error: 'Invalid pagination params' });
    const { page, limit } = parsed.data;
    const { status } = req.query;
    const data = await listDisputes({
      page,
      limit,
      status: typeof status === 'string' ? status : null
    });
    res.json(data);
  } catch (error) {
    next(error);
  }
});

disputeAdminRouter.post('/disputes/:id/evidence', requirePermission(PERMISSIONS.DISPUTES_MANAGE), async (req, res, next) => {
  try {
    const { type, url, description } = req.body ?? {};
    if (!DISPUTE_EVIDENCE_TYPES.includes(type)) {
      return res.status(400).json({ error: 'Invalid evidence type' });
    }
    if (typeof url !== 'string' || url.trim() === '') {
      return res.status(400).json({ error: 'Evidence url is required' });
    }
    const evidence = await addDisputeEvidence(req.params.id, {
      type,
      url: url.trim(),
      description: typeof description === 'string' ? description : null
    });
    await auditFromRequest(req, 'dispute.evidence', {
      targetType: 'dispute',
      targetId: req.params.id,
      metadata: { evidenceId: evidence.id, type }
    });
    res.status(201).json({ evidence });
  } catch (error) {
    if (error instanceof DisputeCaseNotFoundError || error?.name === 'DisputeCaseNotFoundError') {
      return res.status(404).json({ error: error.message });
    }
    next(error);
  }
});

// Decision (single source handler; `/decision` is the canonical contract path,
// `/decide` is kept as a back-compat alias for earlier client builds).
const decideHandler = async (req, res, next) => {
  try {
    const { status, resolution, resultCorrection, moneyAdjustment } = req.body ?? {};
    if (!['RESOLVED', 'DISMISSED'].includes(status)) {
      return res.status(400).json({ error: 'status must be RESOLVED or DISMISSED' });
    }
    if (typeof resolution !== 'string' || resolution.trim() === '') {
      return res.status(400).json({ error: 'resolution is required' });
    }

    let parsedMoneyAdjustment = null;
    if (moneyAdjustment) {
      if (!(await hasPermission(req.user.id, PERMISSIONS.LEDGER_ADJUST))) {
        await auditFromRequest(req, 'dispute.decide', {
          targetType: 'dispute',
          targetId: req.params.id,
          outcome: 'DENIED',
          metadata: { reason: 'money_adjustment_requires_ledger.adjust' }
        });
        return res.status(403).json({
          error: { code: 'FORBIDDEN', message: 'Money adjustment on a dispute requires the ledger.adjust permission' }
        });
      }
      if (!moneyAdjustment.userId || !['CREDIT', 'DEBIT'].includes(moneyAdjustment.direction)) {
        return res.status(400).json({ error: 'moneyAdjustment requires userId and direction (CREDIT or DEBIT)' });
      }
      const amount = parseMinorUnits(moneyAdjustment.amountMinorUnits);
      if (amount === null || amount === 0n) {
        return res.status(400).json({ error: 'amountMinorUnits must be a positive minor-unit string' });
      }
      parsedMoneyAdjustment = { ...moneyAdjustment, amountMinorUnits: amount };
    }

    let parsedCorrection = null;
    if (resultCorrection) {
      const winnerId =
        typeof resultCorrection.winnerId === 'string' && resultCorrection.winnerId.trim() !== '' ? resultCorrection.winnerId : null;
      const endReason =
        typeof resultCorrection.endReason === 'string' && resultCorrection.endReason.trim() !== '' ? resultCorrection.endReason : null;
      if (!winnerId) {
        return res.status(400).json({ error: 'resultCorrection requires a winnerId' });
      }
      parsedCorrection = { winnerId, endReason };
    }

    const result = await decideDispute(req.params.id, req.user.id, {
      status,
      resolution,
      resultCorrection: parsedCorrection,
      moneyAdjustment: parsedMoneyAdjustment
    });

    await auditFromRequest(req, 'dispute.decide', {
      targetType: 'dispute',
      targetId: req.params.id,
      metadata: {
        status,
        resolution: resolution.trim(),
        resultCorrection: Boolean(parsedCorrection),
        moneyAdjustment: Boolean(parsedMoneyAdjustment),
        ...(parsedMoneyAdjustment
          ? { adjustmentReference: `dispute:${req.params.id}`, adjustmentDirection: parsedMoneyAdjustment.direction }
          : {})
      }
    });

    res.json({
      disputeCase: result.disputeCase,
      ...(result.correction ? { correction: result.correction } : {}),
      ...(result.adjustment ? { adjustment: result.adjustment } : {})
    });
  } catch (error) {
    if (error instanceof DisputeCaseNotFoundError || error?.name === 'DisputeCaseNotFoundError') {
      return res.status(404).json({ error: error.message });
    }
    if (error instanceof DisputeCaseNotReviewableError || error?.name === 'DisputeCaseNotReviewableError') {
      return res.status(409).json({ error: error.message });
    }
    if (error instanceof DisputeAdjustmentError || error?.name === 'DisputeAdjustmentError') {
      await auditFromRequest(req, 'ledger.adjustment', {
        targetType: 'dispute',
        targetId: req.params.id,
        outcome: 'FAILURE',
        metadata: { reference: `dispute:${req.params.id}`, reason: error.message }
      });
      return res.status(422).json({
        error: {
          code: 'ADJUSTMENT_FAILED',
          message: error.message,
          decisionRecorded: true,
          retryVia: { path: '/admin/ledger/adjustments', reference: `dispute:${req.params.id}` }
        }
      });
    }
    if (error?.name === 'InsufficientFundsError') {
      return res.status(422).json({ error: { code: 'ADJUSTMENT_FAILED', message: error.message, decisionRecorded: true } });
    }
    if (error?.name === 'InvalidAmountError') {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
};

disputeAdminRouter.post('/disputes/:id/decision', requirePermission(PERMISSIONS.DISPUTES_MANAGE), decideHandler);
disputeAdminRouter.post('/disputes/:id/decide', requirePermission(PERMISSIONS.DISPUTES_MANAGE), decideHandler);

// Participant raise. Mounted at /api/v1/matches in app.js; matched BEFORE the
// parent ensureMatch guard so cases are self-contained in this module.
export const disputeUserRouter = express.Router();

disputeUserRouter.use(requireAuth);

disputeUserRouter.post('/:matchId/disputes', requireIdempotencyKey, async (req, res, next) => {
  try {
    const { category, message, evidence } = req.body ?? {};
    if (typeof message !== 'string' || message.trim() === '') {
      return res.status(400).json({ error: { code: 'INVALID_ARGUMENT', message: 'message is required' } });
    }
    if (Array.isArray(evidence) && evidence.length > 20) {
      return res.status(400).json({ error: { code: 'INVALID_ARGUMENT', message: 'too many evidence references' } });
    }
    const created = await raiseDispute(req.params.matchId, req.user.id, {
      category: typeof category === 'string' ? category : null,
      message: message.trim(),
      evidence
    });
    res.status(201).json({
      disputeId: created.id,
      status: created.status,
      matchId: created.matchId,
      category: created.category ?? null
    });
  } catch (error) {
    if (error instanceof DisputeNotEligibleError || error?.name === 'DisputeNotEligibleError') {
      const isMissing = /not found/i.test(error.message);
      return res.status(isMissing ? 404 : 403).json({ error: { code: 'DISPUTE_NOT_ELIGIBLE', message: error.message } });
    }
    if (error instanceof DisputeWindowExpiredError || error?.name === 'DisputeWindowExpiredError') {
      return res.status(409).json({ error: { code: 'DISPUTE_WINDOW_EXPIRED', message: error.message } });
    }
    if (error instanceof DuplicateDisputeError || error?.name === 'DuplicateDisputeError') {
      return res.status(409).json({ error: { code: 'DUPLICATE_DISPUTE', message: error.message } });
    }
    next(error);
  }
});