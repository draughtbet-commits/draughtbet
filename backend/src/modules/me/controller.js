import express from 'express';
import { z } from 'zod';
import prisma from '../../utils/db.js';
import { AuthService } from '../auth/service.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireIdempotencyKey } from '../../middleware/idempotency.js';
import { EligibilityService } from '../eligibility/service.js';
import { withdrawalService } from '../withdrawal/controller.js';
import { PaymentGatewayError } from '../payment/PaymentGateway.js';
import {
  registerPushToken,
  listPushTokens,
  revokePushToken,
  PushTokenError
} from './pushTokenService.js';

export const meRouter = express.Router();

const eligibilityService = new EligibilityService();

const eligibilityQuerySchema = z.object({
  action: z.enum(['WITHDRAW', 'DEPOSIT', 'PLAY', 'JOIN', 'CREATE', 'STAKE']),
  amount: z.string().regex(/^\d+$/, 'amount must be a positive integer').refine((s) => BigInt(s) > 0n, 'amount must be positive').optional()
});

// Frequent NGN codes used to fill the display bank name when the client omits
// it; this is presentation only, never a verification signal.
const NGN_BANKS = {
  '044': 'Access Bank',
  '063': 'Access Bank (Diamond)',
  '035': 'ALAT by Wema',
  '023': 'Citibank Nigeria',
  '050': 'Ecobank Nigeria',
  '070': 'Fidelity Bank',
  '011': 'First Bank of Nigeria',
  '214': 'First City Monument Bank',
  '058': 'Guaranty Trust Bank',
  '030': 'Heritage Bank',
  '301': 'Jaiz Bank',
  '082': 'Keystone Bank',
  '076': 'Polaris Bank',
  '101': 'Providus Bank',
  '221': 'Stanbic IBTC',
  '232': 'Sterling Bank',
  '032': 'Union Bank',
  '033': 'UBA',
  '215': 'Unity Bank',
  '035': 'Wema Bank',
  '057': 'Zenith Bank'
};

// V2 list payload (withdrawal §2): every destination the user has saved.
const bankAccountPayload = (b) => ({
  id: b.id,
  gateway: b.gateway,
  bankCode: b.bankCode,
  bankName: b.bankName,
  accountNumber: b.accountNumber,
  accountName: b.accountName,
  isDefault: b.isDefault,
  verifiedAt: b.verifiedAt,
  createdAt: b.createdAt
});

const updateProfileSchema = z.object({
  // Only predesigned avatar ids are accepted. No uploads.
  avatar: z.string().trim().min(1).max(64)
});

const pushTokenSchema = z.object({
  token: z.string().trim().min(1).max(4096),
  platform: z.enum(['ios', 'android', 'web']),
  deviceId: z.string().trim().min(1).max(128).optional()
});

meRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const profile = await AuthService.getProfile(req.user.id);
    res.json(profile);
  } catch (err) {
    next(err);
  }
});

meRouter.patch('/', requireAuth, async (req, res, next) => {
  try {
    const data = updateProfileSchema.parse(req.body);
    const profile = await AuthService.updateProfile(req.user.id, { avatar: data.avatar });
    res.json(profile);
  } catch (err) {
    if (err && err.name === 'ZodError') {
      return res.status(400).json({ errors: err.errors || err.issues });
    }
    if (err.message === 'User not found') {
      return res.status(404).json({ error: err.message });
    }
    next(err);
  }
});

meRouter.get('/sessions', requireAuth, async (req, res, next) => {
  try {
    const sessions = await AuthService.listSessions(req.user.id, { currentSessionId: req.sessionId });
    res.json({ data: sessions });
  } catch (err) {
    next(err);
  }
});

meRouter.delete('/sessions/:sessionId', requireAuth, async (req, res, next) => {
  try {
    const result = await AuthService.revokeSession(req.user.id, req.params.sessionId, {
      ip: req.ip,
      userAgent: req.get('user-agent')
    });
    res.json({ data: result });
  } catch (err) {
    if (err && err.name === 'VerificationChallengeError') {
      return res.status(err.status ?? 400).json({ error: { code: err.code, message: err.message } });
    }
    next(err);
  }
});

meRouter.post('/push-tokens', requireAuth, async (req, res, next) => {
  try {
    const data = pushTokenSchema.parse(req.body ?? {});
    const token = await registerPushToken(req.user.id, data);
    res.status(201).json({ data: token });
  } catch (err) {
    if (err && err.name === 'ZodError') {
      return res.status(400).json({ errors: err.errors || err.issues });
    }
    if (err && err.name === 'PushTokenError') {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

meRouter.get('/push-tokens', requireAuth, async (req, res, next) => {
  try {
    const tokens = await listPushTokens(req.user.id);
    res.json({ data: tokens });
  } catch (err) {
    next(err);
  }
});

meRouter.delete('/push-tokens/:id', requireAuth, async (req, res, next) => {
  try {
    const result = await revokePushToken(req.user.id, req.params.id);
    res.json({ data: result });
  } catch (err) {
    if (err && err.name === 'PushTokenError') {
      return res.status(404).json({ error: err.message });
    }
    next(err);
  }
});

// Contract §2 GET /me/bank-accounts — saved payout destinations (V2 envelope).
meRouter.get('/bank-accounts', requireAuth, async (req, res, next) => {
  try {
    const accounts = await withdrawalService.listBankAccounts(req.user.id);
    res.json({ data: accounts });
  } catch (err) {
    next(err);
  }
});

// Contract §2 POST /me/bank-accounts — verify and save a payout destination.
// The app posts only {bankCode, accountNumber}; the display bank name is
// derived when omitted. Provider verification is attempted first; outside
// production a provider rejection degrades to a locally verified row so the
// sandbox app can proceed. Production stays strict (provider-only).
meRouter.post('/bank-accounts', requireAuth, requireIdempotencyKey({ scope: 'bank-account' }), async (req, res, next) => {
  try {
    const userId = req.user.id;
    const bankCode = String(req.body?.bankCode ?? '').trim();
    const accountNumber = String(req.body?.accountNumber ?? '').trim();
    const bankName = String(req.body?.bankName ?? '').trim();

    if (!/^\d{1,10}$/.test(bankCode) || !/^\d{6,20}$/.test(accountNumber)) {
      return res.status(400).json({ error: 'Invalid bank account details' });
    }

    const existing = await prisma.bankAccount.findFirst({ where: { userId, accountNumber } });
    if (existing) {
      return res.status(201).json({ data: { ...bankAccountPayload(existing), verified: true } });
    }

    const resolvedBankName = bankName || NGN_BANKS[bankCode] || `Bank ${bankCode}`;
    let account;
    try {
      account = await withdrawalService.createBankAccount(userId, {
        gateway: 'PAYSTACK',
        bankCode,
        bankName: resolvedBankName,
        accountNumber
      });
    } catch (err) {
      if (process.env.NODE_ENV === 'production' || !(err instanceof PaymentGatewayError)) {
        throw err;
      }
      account = await prisma.$transaction(async (tx) => {
        const count = await tx.bankAccount.count({ where: { userId } });
        await tx.bankAccount.updateMany({
          where: { userId, isDefault: true },
          data: { isDefault: false }
        });
        return tx.bankAccount.create({
          data: {
            userId,
            gateway: 'PAYSTACK',
            bankCode,
            bankName: resolvedBankName,
            accountNumber,
            accountName: '',
            isDefault: count === 0,
            verifiedAt: new Date()
          }
        });
      });
    }
    res.status(201).json({ data: { ...bankAccountPayload(account), verified: true } });
  } catch (err) {
    if (err?.name === 'InvalidBankAccountError') {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof PaymentGatewayError) {
      return res.status(422).json({ error: err.message });
    }
    next(err);
  }
});

// Contract §2 GET /me/matches — completed match history with per-player outcome
// (WON/DRAW/LOST) derived from the match winner and the user's receipt.
meRouter.get('/matches', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const matches = await prisma.match.findMany({
      where: {
        AND: [
          { OR: [{ playerLightId: userId }, { playerDarkId: userId }] },
          { status: { in: ['COMPLETED', 'SETTLED'] } }
        ]
      },
      orderBy: { endedAt: 'desc' },
      take: 50,
      select: {
        id: true,
        playerLightId: true,
        playerDarkId: true,
        winnerId: true,
        status: true,
        endReason: true,
        stakeMinorUnits: true,
        settlementCommissionPercent: true,
        endedAt: true,
        receipts: {
          where: { userId },
          select: { stakeMinorUnits: true, payoutMinorUnits: true }
        }
      }
    });

    const items = matches.map((m) => {
      const receipt = m.receipts?.[0];
      const stake = Number(m.stakeMinorUnits ?? 0n);
      const outcome = m.winnerId == null
        ? 'DRAW'
        : m.winnerId === userId
          ? 'WON'
          : 'LOST';
      const derivedPayout = outcome === 'WON'
        ? Math.round(2 * stake * (100 - (m.settlementCommissionPercent ?? 0)) / 100)
        : 0;
      return {
        id: m.id,
        playerLightId: m.playerLightId,
        playerDarkId: m.playerDarkId,
        winnerId: m.winnerId,
        status: m.status,
        endReason: m.endReason,
        outcome,
        stakeMinor: Number(receipt?.stakeMinorUnits ?? stake),
        payoutMinor: Number(receipt?.payoutMinorUnits ?? derivedPayout),
        endedAt: m.endedAt
      };
    });

    res.json({ data: items });
  } catch (err) {
    next(err);
  }
});

// Contract §4: GET /me/eligibility — read-only explanation of the gate for an
// action. It only explains (never decides), so a 403/422 body still returns the
// gate report rather than a thrown error.
meRouter.get('/eligibility', requireAuth, async (req, res, next) => {
  try {
    const query = Object.fromEntries(
      Object.entries(req.query || {}).map(([k, v]) => [k, typeof v === 'string' ? v : String(v)])
    );
    const parsed = eligibilityQuerySchema.parse(query);
    const report = await eligibilityService.explain(req.user.id, {
      action: parsed.action,
      amountMinorUnits: parsed.amount
    });
    res.status(report.allowed ? 200 : report.status).json(report);
  } catch (err) {
    if (err && err.name === 'ZodError') {
      return res.status(400).json({ errors: err.errors || err.issues });
    }
    next(err);
  }
});