import crypto from 'crypto';
import prisma from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { InsufficientFundsError, lockWalletForUpdate } from '../../services/matchService.js';
import { assertEligibleForMoney } from '../../services/eligibilityService.js';
import {
  postWithdrawalReserve,
  postWithdrawalComplete,
  postWithdrawalRelease
} from '../../services/ledgerService.js';
import { parseMinorUnits, parseIdempotencyKey } from '../wallet/service.js';
import { enqueueWalletUpdated, enqueueNotificationDelivery } from '../../services/outboxService.js';
import { PaymentGatewayError } from '../payment/PaymentGateway.js';

export class BankAccountRequiredError extends Error {
  constructor(message = 'A verified bank account is required for withdrawals') {
    super(message);
    this.name = 'BankAccountRequiredError';
  }
}

export class BankAccountNotFoundError extends Error {
  constructor(message = 'Bank account not found') {
    super(message);
    this.name = 'BankAccountNotFoundError';
  }
}

export class BankAccountNotVerifiedError extends Error {
  constructor(message = 'Bank account has not been verified at the provider') {
    super(message);
    this.name = 'BankAccountNotVerifiedError';
  }
}

export class WithdrawalNotFoundError extends Error {
  constructor(message = 'Withdrawal not found') {
    super(message);
    this.name = 'WithdrawalNotFoundError';
  }
}

export class WithdrawalStateError extends Error {
  constructor(message = 'Withdrawal is not in a legal state for that action') {
    super(message);
    this.name = 'WithdrawalStateError';
  }
}

export const WITHDRAWAL_STATUSES = Object.freeze([
  'PENDING_REVIEW',
  'APPROVED',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
  'RELEASED'
]);

// Payment destinations that can still be released back to the player (funds
// are reserved but have not definitively left the platform).
const RELEASABLE_STATUSES = Object.freeze(['PENDING_REVIEW', 'APPROVED', 'FAILED']);

const RELATIVE_TO_MAJOR_UNITS = (amount) =>
  `${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}`;

const toPayload = (w) => ({
  id: w.id,
  userId: w.userId,
  amountMinorUnits: w.amountMinorUnits.toString(),
  currency: w.currency,
  reference: w.reference,
  gateway: w.gateway,
  status: w.status,
  bankAccountId: w.bankAccountId,
  providerRef: w.providerRef,
  reviewedBy: w.reviewedBy,
  reviewedAt: w.reviewedAt,
  processedAt: w.processedAt,
  failureReason: w.failureReason,
  createdAt: w.createdAt,
  updatedAt: w.updatedAt
});

/**
 * Withdrawal V2 lifecycle:
 *
 *   request           PENDING_REVIEW   funds reserved (wallet debit + ledger
 *                                      PLAYER_AVAILABLE -> PLAYER_WITHDRAWAL_PENDING)
 *   admin approve     APPROVED         reviewedBy/reviewedAt snapshot
 *   begin payout      PROCESSING       provider transfer initiated, providerRef set
 *   payout confirmed  COMPLETED        ledger PLAYER_WITHDRAWAL_PENDING -> CUSTOMER_LIABILITY
 *      |   provider/admin failure     FAILED          funds still reserved; retry or release
 *   release (reject/fail settle)      RELEASED        ledger pending -> PLAYER_AVAILABLE + wallet refund
 *
 * Exit gates:
 *   - concurrent requests/races serialize on the wallet FOR UPDATE row lock, so
 *     two simultaneous withdrawals can never overspend (legacy wallet gate).
 *   - every status move is a conditional, idempotent update; the ledger postings
 *     share the same transaction and carry per-withdrawal idempotency keys, so
 *     duplicate callbacks/actions can never reserve, complete or release twice.
 *
 * Provider calls (resolve/createRecipient/initiatePayout) are injected so tests
 * and verification can substitute a fake client — no real money moves in tests.
 */
export class WithdrawalService {
  constructor({ providers = {} } = {}) {
    this.providers = providers; // { PAYSTACK: gateway, FLUTTERWAVE: gateway }
  }

  /**
   * Creates a withdrawal request: eligibility + payout-destination gates first,
   * then wallet-lock, ledger funds check, reserve (PENDING_REVIEW + V2 ledger
   * reservation) — all in one transaction. A client idempotencyKey makes a
   * replay return the original request untouched.
   */
  async requestWithdrawal(userId, amountMinorUnits, idempotencyKey, bankAccountId) {
    const amount = parseMinorUnits(amountMinorUnits);
    if (amount === null) {
      const error = new Error('Invalid amount');
      error.name = 'InvalidAmountError';
      throw error;
    }
    const key = parseIdempotencyKey(idempotencyKey);

    // Money-OUT gate: account state + verified KYC + self-exclusion. The
    // verified-KYC requirement is enforced at withdrawals (not deposits or
    // match creation), per the safer-play scope.
    await assertEligibleForMoney(prisma, userId, { requireKyc: true });

    try {
      return await prisma.$transaction(async (tx) => {
        const wallet = await lockWalletForUpdate(tx, userId);

        // 1. Idempotent replay: a request with this key already exists.
        if (key !== undefined) {
          const existing = await tx.withdrawal.findFirst({
            where: { userId, idempotencyKey: key }
          });
          if (existing) return toPayload(existing);
        }

        // 2. Payout destination must be a provider-verified account.
        const bankAccount = await this.pickVerifiedBankAccount(tx, userId, bankAccountId);

        // 3. Ledger PLAYER_AVAILABLE net must cover the request. Debits are
        //    serialized by the wallet lock above; credits only add funds.
        const userAccounts = await tx.ledgerAccount.findMany({
          where: { userId, type: 'PLAYER_AVAILABLE' }
        });
        const availableNet = await tx.ledgerEntry.aggregate({
          where: { accountId: { in: userAccounts.map((a) => a.id) } },
          _sum: { amountMinorUnits: true }
        });
        if ((availableNet._sum.amountMinorUnits ?? 0n) < amount) {
          throw new InsufficientFundsError();
        }

        const reference = `wit-${crypto.randomUUID()}`;
        const currency = wallet.currency ?? 'NGN';

        // 4. Reserve: create the V2 row + ledger reservation atomically.
        const withdrawal = await tx.withdrawal.create({
          data: {
            userId,
            amountMinorUnits: amount,
            currency,
            reference,
            gateway: bankAccount.gateway,
            bankAccountId: bankAccount.id,
            status: 'PENDING_REVIEW',
            ...(key !== undefined ? { idempotencyKey: key } : {})
          }
        });

        await postWithdrawalReserve(tx, {
          withdrawalId: withdrawal.id,
          userId,
          amountMinorUnits: amount,
          currency
        });

        // Durable wallet.updated outbox row, atomic with the debit.
        await enqueueWalletUpdated(tx, {
          userId,
          walletId: wallet.id,
          currency,
          type: 'WITHDRAWAL',
          amountMinorUnits: amount,
          dedupeKey: `wallet:withdrawal:${withdrawal.id}`
        });

        logger.info({ withdrawalId: withdrawal.id, userId, amount: amount.toString() }, 'Withdrawal requested and reserved');
        return toPayload(withdrawal);
      });
    } catch (error) {
      // 4. Two requests raced with the same (userId, idempotencyKey): the whole
      //    transaction — including the debit — was rolled back. Return the
      //    winner's request so the caller sees an identical result.
      if (error?.code === 'P2002' && key !== undefined) {
        const existing = await prisma.withdrawal.findFirst({
          where: { userId, idempotencyKey: key }
        });
        if (existing) return toPayload(existing);
      }
      throw error;
    }
  }

  async pickVerifiedBankAccount(tx, userId, bankAccountId) {
    let bankAccount = null;
    if (bankAccountId) {
      bankAccount = await tx.bankAccount.findFirst({
        where: { id: bankAccountId, userId }
      });
      if (!bankAccount) throw new BankAccountNotFoundError();
    } else {
      bankAccount = await tx.bankAccount.findFirst({
        where: { userId, isDefault: true }
      });
    }
    if (!bankAccount) throw new BankAccountRequiredError();
    if (!bankAccount.verifiedAt || !bankAccount.recipientRef) {
      throw new BankAccountNotVerifiedError();
    }
    return bankAccount;
  }

  async listWithdrawals(userId, { page = 1, limit = 20, status } = {}) {
    const skip = (page - 1) * limit;
    const where = { userId, ...(status ? { status } : {}) };
    const [rows, total] = await Promise.all([
      prisma.withdrawal.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.withdrawal.count({ where })
    ]);
    return { withdrawals: rows.map(toPayload), total };
  }

  // -------------------------------------------------------------------------
  // Bank accounts (payout destinations)
  // -------------------------------------------------------------------------

  /**
   * Creates (and verifies) a payout destination. The provider is asked to
   * resolve the account (returns the on-file name) and to create a reusable
   * recipient; both must succeed before a row is persisted.
   */
  async createBankAccount(userId, { gateway, bankCode, bankName, accountNumber }) {
    if (gateway !== 'PAYSTACK' && gateway !== 'FLUTTERWAVE') {
      throw new PaymentGatewayError('Unsupported payout provider');
    }
    const code = typeof bankCode === 'string' ? bankCode.trim() : '';
    const number = typeof accountNumber === 'string' ? accountNumber.trim() : '';
    const name = typeof bankName === 'string' ? bankName.trim() : '';
    if (!/^\d{1,10}$/.test(code) || !/^\d{6,20}$/.test(number) || name === '') {
      const error = new Error('Invalid bank account details');
      error.name = 'InvalidBankAccountError';
      throw error;
    }

    const existing = await prisma.bankAccount.findFirst({
      where: { userId, accountNumber: number }
    });
    if (existing) return existing;

    const provider = this.providers[gateway];
    if (!provider) throw new PaymentGatewayError('Payout provider not configured');

    // Provider verification + recipient creation happen OUTSIDE the DB
    // transaction so a slow upstream never holds a row lock.
    const resolved = await provider.resolveBankAccount({ bankCode: code, accountNumber: number });
    const recipient = await provider.createRecipient({
      bankCode: code,
      accountNumber: number,
      accountName: resolved.accountName
    });

    return await prisma.$transaction(async (tx) => {
      const [firstWillBeDefault] = await Promise.all([
        tx.bankAccount.count({ where: { userId } })
      ]);
      await tx.bankAccount.updateMany({
        where: { userId, isDefault: true },
        data: { isDefault: false }
      });
      return tx.bankAccount.create({
        data: {
          userId,
          gateway,
          bankCode: code,
          bankName: name,
          accountNumber: number,
          accountName: resolved.accountName,
          verifiedName: resolved.accountName,
          recipientRef: recipient.recipientRef,
          verifiedAt: new Date(),
          isDefault: firstWillBeDefault === 0
        }
      });
    }).catch((error) => {
      if (error?.code === 'P2002') {
        // Raced with a concurrent create of the same account; return the winner.
        return prisma.bankAccount.findFirst({ where: { userId, accountNumber: number } });
      }
      throw error;
    });
  }

  async listBankAccounts(userId) {
    const rows = await prisma.bankAccount.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }]
    });
    return rows.map((b) => ({
      id: b.id,
      gateway: b.gateway,
      bankCode: b.bankCode,
      bankName: b.bankName,
      accountNumber: b.accountNumber,
      accountName: b.accountName,
      isDefault: b.isDefault,
      verifiedAt: b.verifiedAt,
      createdAt: b.createdAt
    }));
  }

  async setDefaultBankAccount(userId, bankAccountId) {
    return await prisma.$transaction(async (tx) => {
      const account = await tx.bankAccount.findFirst({
        where: { id: bankAccountId, userId }
      });
      if (!account) throw new BankAccountNotFoundError();
      await tx.bankAccount.updateMany({
        where: { userId, isDefault: true },
        data: { isDefault: false }
      });
      return tx.bankAccount.update({
        where: { id: account.id },
        data: { isDefault: true }
      });
    });
  }

  async deleteBankAccount(userId, bankAccountId) {
    const account = await prisma.bankAccount.findFirst({
      where: { id: bankAccountId, userId }
    });
    if (!account) throw new BankAccountNotFoundError();
    // Withdrawals referencing it fall back to SetNull; existing rows keep the
    // amount/status and the service refuses new payouts without a destination.
    await prisma.bankAccount.delete({ where: { id: account.id } });
    return { deleted: true };
  }

  // -------------------------------------------------------------------------
  // Admin / provider lifecycle
  // -------------------------------------------------------------------------

  async listAllWithdrawals({ page = 1, limit = 20, status } = {}) {
    const skip = (page - 1) * limit;
    const where = status ? { status } : {};
    const [rows, total] = await Promise.all([
      prisma.withdrawal.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.withdrawal.count({ where })
    ]);
    return { withdrawals: rows.map(toPayload), total };
  }

  /**
   * PENDING_REVIEW -> APPROVED, conditional and idempotent.
   */
  async approveWithdrawal(withdrawalId, adminId) {
    return await prisma.$transaction(async (tx) => {
      const updated = await tx.withdrawal.updateMany({
        where: { id: withdrawalId, status: 'PENDING_REVIEW' },
        data: { status: 'APPROVED', reviewedBy: adminId, reviewedAt: new Date() }
      });
      const row = await tx.withdrawal.findUnique({ where: { id: withdrawalId } });
      if (!row) throw new WithdrawalNotFoundError();
      if (updated.count === 0 && row.status === 'RELEASED') {
        throw new WithdrawalStateError('Withdrawal was already released');
      }
      return toPayload(row);
    });
  }

  /**
   * APPROVED (or FAILED retry) -> PROCESSING: reserve the right to initiate at
   * the provider with a conditional CAS so a racing second admin can never
   * double-initiate a payout.
   */
  async beginPayout(withdrawalId) {
    const withdrawal = await prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
    if (!withdrawal) throw new WithdrawalNotFoundError();
    if (withdrawal.status !== 'APPROVED' && withdrawal.status !== 'FAILED') {
      throw new WithdrawalStateError('Only APPROVED or FAILED withdrawals can begin a payout');
    }

    const provider = this.providers[withdrawal.gateway];
    if (!provider) throw new PaymentGatewayError('Payout provider not configured');

    const bankAccount = withdrawal.bankAccountId
      ? await prisma.bankAccount.findUnique({ where: { id: withdrawal.bankAccountId } })
      : null;
    if (!bankAccount?.recipientRef) {
      throw new BankAccountRequiredError('Payout destination is missing or unverified');
    }

    // CAS to PROCESSING — exactly one caller wins; losers get the row back and
    // must not call the provider.
    const claimed = await prisma.withdrawal.updateMany({
      where: { id: withdrawalId, status: withdrawal.status },
      data: { status: 'PROCESSING', processedAt: new Date() }
    });
    const current = await prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
    if (claimed.count === 0) {
      if (current?.status === 'PROCESSING') return toPayload(current);
      throw new WithdrawalStateError('Withdrawal payout is already in flight or terminal');
    }

    try {
      const result = await provider.initiatePayout({
        amountMinorUnits: current.amountMinorUnits,
        currency: current.currency,
        recipientRef: bankAccount.recipientRef,
        reference: current.reference
      });
      const updated = await prisma.withdrawal.update({
        where: { id: current.id },
        data: { providerRef: result.providerRef }
      });
      return toPayload(updated);
    } catch (error) {
      const reason = error?.message || 'Provider payout initiation failed';
      logger.error({ withdrawalId, error }, 'Payout initiation failed');
      const failed = await prisma.withdrawal.update({
        where: { id: current.id },
        data: { status: 'FAILED', failureReason: reason }
      });
      return toPayload(failed);
    }
  }

  /**
   * Ends the payout lifecycle for a PROCESSING withdrawal. Success posts the
   * V2 WITHDRAWAL_COMPLETE (pending -> liability, funds leave the platform)
   * + user notification inside the SAME transaction as the status CAS, so a
   * duplicated callback/admin action can never double-complete. Failure keeps
   * the funds reserved and records failureReason (admin may release or retry).
   */
  async reportPayoutResult(withdrawalId, { success, failureReason }) {
    return await prisma.$transaction(async (tx) => {
      const w = await tx.withdrawal.findUnique({ where: { id: withdrawalId } });
      if (!w) throw new WithdrawalNotFoundError();
      if (w.status === 'COMPLETED') return toPayload(w);

      // Atomic CAS: only the winning caller posts side effects, so a concurrent
      // duplicate callback can never double-create notifications or postings.
      const claimed = await tx.withdrawal.updateMany({
        where: { id: withdrawalId, status: 'PROCESSING' },
        data: success
          ? { status: 'COMPLETED' }
          : { status: 'FAILED', failureReason: failureReason || 'Provider reported a failed payout' }
      });
      if (claimed.count === 0) {
        // A racing duplicate already resolved the payout — acknowledge, no-op.
        const current = await tx.withdrawal.findUnique({ where: { id: withdrawalId } });
        if (current?.status === 'COMPLETED') return toPayload(current);
        throw new WithdrawalStateError('Payout result can only be reported for a PROCESSING withdrawal');
      }

      if (success) {
        await postWithdrawalComplete(tx, {
          withdrawalId: w.id,
          userId: w.userId,
          amountMinorUnits: w.amountMinorUnits,
          currency: w.currency
        });
        const confirmed = await tx.notification.create({
          data: {
            userId: w.userId,
            type: 'WITHDRAWAL_CONFIRMED',
            title: 'Withdrawal Complete',
            message: `Your withdrawal of ₦${RELATIVE_TO_MAJOR_UNITS(w.amountMinorUnits)} has been paid out.`,
            link: '/wallet'
          }
        });
        await enqueueNotificationDelivery(tx, confirmed, {
          dedupeKey: `notify:withdrawal:${w.id}`
        });
        logger.info({ withdrawalId: w.id, userId: w.userId }, 'Withdrawal completed');
      } else {
        logger.warn({ withdrawalId: w.id, userId: w.userId, reason: failureReason }, 'Withdrawal payout failed; funds remain reserved');
      }

      const updated = await tx.withdrawal.findUnique({ where: { id: w.id } });
      return toPayload(updated);
    });
  }

  /**
   * Records when the follow-up sweep last probed a PROCESSING withdrawal, so
   * each run only re-probes rows that are actually due.
   */
  async noteFollowUpCheck(withdrawalId) {
    const { count } = await prisma.withdrawal.updateMany({
      where: { id: withdrawalId, status: 'PROCESSING' },
      data: { followUpCheckAt: new Date() }
    });
    return count === 1;
  }

  /**
   * Releases a withdrawal that will never be paid (admin rejection or a failed
   * payout the operator chooses not to retry): PLAYER_WITHDRAWAL_PENDING ->
   * PLAYER_AVAILABLE, atomic, so the pending funds return exactly once.
   * PROCESSING is deliberately NOT releasable (the provider may hold real money);
   * the operator must first resolve the payout result, then release if it failed.
   */
  async releaseWithdrawal(withdrawalId, { failureReason, adminId } = {}) {
    return await prisma.$transaction(async (tx) => {
      const w = await tx.withdrawal.findUnique({ where: { id: withdrawalId } });
      if (!w) throw new WithdrawalNotFoundError();
      if (w.status === 'RELEASED') return toPayload(w);
      if (!RELEASABLE_STATUSES.includes(w.status)) {
        throw new WithdrawalStateError(
          w.status === 'PROCESSING'
            ? 'Resolve the payout result before releasing a PROCESSING withdrawal'
            : `Withdrawal in ${w.status} cannot be released`
        );
      }

      const updated = await tx.withdrawal.update({
        where: { id: w.id },
        data: {
          status: 'RELEASED',
          ...(failureReason ? { failureReason } : {}),
          ...(adminId ? { reviewedBy: adminId, reviewedAt: new Date() } : {})
        }
      });

      await postWithdrawalRelease(tx, {
        withdrawalId: w.id,
        userId: w.userId,
        amountMinorUnits: w.amountMinorUnits,
        currency: w.currency
      });

      // The Wallet row still owns the ordered-lock + currency contract, so the
      // durable wallet.updated outbox row keeps using its id as the aggregateId.
      const wallet = await tx.wallet.findUnique({ where: { userId: w.userId } });
      if (wallet) {
        await enqueueWalletUpdated(tx, {
          userId: w.userId,
          walletId: wallet.id,
          currency: w.currency,
          type: 'WITHDRAWAL_RELEASE',
          amountMinorUnits: w.amountMinorUnits,
          dedupeKey: `wallet:withdrawal-release:${w.id}`
        });
      }

      const refunded = await tx.notification.create({
        data: {
          userId: w.userId,
          type: 'WITHDRAWAL_REFUNDED',
          title: 'Withdrawal Returned',
          message: `₦${RELATIVE_TO_MAJOR_UNITS(w.amountMinorUnits)} from your pending withdrawal has been returned to your wallet.`,
          link: '/wallet'
        }
      });
      await enqueueNotificationDelivery(tx, refunded, {
        dedupeKey: `notify:withdrawal:${w.id}`
      });

      logger.info({ withdrawalId: w.id, userId: w.userId, reason: failureReason }, 'Withdrawal released back to player');
      return toPayload(updated);
    });
  }

  /**
   * Rejects a PENDING_REVIEW/APPROVED/FAILED withdrawal: release with an
   * explicit rejection reason (thin alias over releaseWithdrawal).
   */
  async rejectWithdrawal(withdrawalId, adminId, reason) {
    return this.releaseWithdrawal(withdrawalId, {
      failureReason: reason || 'Rejected by administrator',
      adminId
    });
  }

  // -------------------------------------------------------------------------
  // Provider payout webhooks
  // -------------------------------------------------------------------------

  /**
   * Idempotent handler for a verified provider transfer event. Looks the
   * withdrawal up by OUR server-generated reference (echoed by the provider),
   * confirms the gateway, then funnels into reportPayoutResult (whose atomic
   * CAS makes a repeated callback a safe no-op). Returns a result object the
   * caller can turn into an HTTP acknowledgement.
   */
  async handlePayoutCallback({ gateway, eventType, data }) {
    const reference = data?.reference;
    if (!reference) {
      logger.warn({ gateway, eventType }, 'Payout webhook missing reference');
      return { handled: false, reason: 'missing_reference' };
    }
    const withdrawal = await prisma.withdrawal.findUnique({ where: { reference } });
    if (!withdrawal) {
      logger.warn({ gateway, eventType, reference }, 'Payout webhook unknown reference');
      return { handled: false, reason: 'unknown_reference' };
    }
    if (withdrawal.gateway !== gateway) {
      logger.warn({ gateway, eventType, reference }, 'Payout webhook gateway does not match withdrawal');
      return { handled: false, reason: 'gateway_mismatch' };
    }

    const status = typeof data?.status === 'string' ? data.status : '';
    const success =
      (gateway === 'PAYSTACK' && eventType === 'transfer.success') ||
      (gateway === 'PAYSTACK' && eventType === 'transfer.successful') ||
      (gateway === 'FLUTTERWAVE' &&
        eventType === 'transfer.completed' &&
        /^SUCCESSFUL$/i.test(status));
    const failed =
      !success &&
      ((gateway === 'PAYSTACK' && ['transfer.failed', 'transfer.reversed'].includes(eventType)) ||
        (gateway === 'FLUTTERWAVE' &&
          eventType === 'transfer.completed' &&
          /FAILED/i.test(status)) ||
        eventType === 'transfer.failed');
    if (!success && !failed) {
      logger.info({ gateway, eventType, status, reference }, 'Payout webhook event acknowledged, not actionable');
      return { handled: false, reason: 'unhandled_event' };
    }

    try {
      const updated = await this.reportPayoutResult(withdrawal.id, {
        success,
        failureReason: success ? undefined : (data.failureReason || data.complete_message || 'Provider reported a failed payout')
      });
      return { handled: true, withdrawal: updated };
    } catch (error) {
      // A duplicate terminal event (or an event for a failed/released
      // withdrawal) is acknowledged, not retried — money never double-moves.
      if (error?.name === 'WithdrawalStateError') {
        return { handled: true, reason: 'ignored_non_processing', withdrawal };
      }
      throw error;
    }
  }
}