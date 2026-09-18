import prisma from '../../utils/db.js';
import {
  postAdjustment,
  getLedgerAvailable
} from '../../services/ledgerService.js';

/**
 * Admin money corrections. The ONLY sanctioned path to move a player's money
 * without a deposit/withdrawal/game event. Balanced double-entry, idempotent
 * per reference, and it writes the wallet.updated outbox row atomically so the
 * player's socket push fires exactly once.
 */
export class AdminService {
  static async postAdjustment({
    userId,
    amountMinorUnits,
    direction,
    reason = null,
    reference,
    actorId = null,
    currency = 'NGN'
  }) {
    return prisma.$transaction(async (tx) => {
      const { transaction } = await postAdjustment(tx, {
        userId,
        amountMinorUnits,
        direction,
        reason,
        reference,
        actorId,
        currency
      });

      await tx.wallet.upsert({
        where: { userId },
        create: { userId, currency },
        update: { currency }
      });
      const wallet = await tx.wallet.findUnique({ where: { userId } });
      await tx.outboxEvent.create({
        data: {
          aggregateType: 'Wallet',
          aggregateId: wallet.id,
          eventType: 'wallet.updated',
          payload: {
            userId,
            walletId: wallet.id,
            currency,
            type: 'ADJUSTMENT',
            amountMinorUnits: amountMinorUnits.toString()
          }
        }
      });

      const available = await getLedgerAvailable(tx, userId, currency);
      return {
        transactionId: transaction.id,
        reference,
        direction,
        available: available.toString()
      };
    });
  }
}