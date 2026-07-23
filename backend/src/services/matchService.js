import crypto from 'crypto';
import prisma from '../utils/db.js';

export class InsufficientFundsError extends Error {
  constructor(message = 'Insufficient funds') {
    super(message);
    this.name = 'InsufficientFundsError';
  }
}

export class InvalidTierError extends Error {
  constructor(message = 'Invalid tier') {
    super(message);
    this.name = 'InvalidTierError';
  }
}

/**
 * Locks wallets in ascending userId order to prevent deadlocks.
 */
export async function lockWalletsInOrder(tx, idA, idB) {
  const sorted = [idA, idB].sort();
  // We use queryRaw to lock the rows
  const w1 = await tx.$queryRaw`SELECT * FROM "Wallet" WHERE "userId" = ${sorted[0]} FOR UPDATE`;
  const w2 = await tx.$queryRaw`SELECT * FROM "Wallet" WHERE "userId" = ${sorted[1]} FOR UPDATE`;
  
  if (!w1 || w1.length === 0) throw new Error(`Wallet not found for userId: ${sorted[0]}`);
  if (!w2 || w2.length === 0) throw new Error(`Wallet not found for userId: ${sorted[1]}`);
  
  return [w1[0], w2[0]];
}

export function getStakeForTier(settings, tier) {
  const key = `${tier.toLowerCase()}StakeMinP`;
  const val = settings[key];
  if (val === undefined || val === null) {
    throw new InvalidTierError(`Invalid tier: ${tier}`);
  }
  return BigInt(val);
}

/**
 * Debits stakes from both players and creates a Match row.
 */
export const debitStakes = async (player1Id, player2Id, stakeTier) => {
  return await prisma.$transaction(async (tx) => {
    // 1. Lock both wallets (ordered by ascending userId to prevent deadlocks)
    const [w1, w2] = await lockWalletsInOrder(tx, player1Id, player2Id);

    // 2. Look up stake amount from PlatformSettings
    const settings = await tx.platformSettings.findUniqueOrThrow({ where: { id: 'singleton' } });
    const stakeAmount = getStakeForTier(settings, stakeTier);

    // 3. Verify BOTH players can afford the stake
    if (BigInt(w1.balanceMinorUnits) < stakeAmount || BigInt(w2.balanceMinorUnits) < stakeAmount) {
      throw new InsufficientFundsError('Insufficient funds for stake');
    }

    // 4. Generate match ID upfront so WalletTransactions can reference it
    const matchId = crypto.randomUUID();

    // 5. Debit both wallets (debit-before-credit ordering)
    for (const w of [w1, w2]) {
      await tx.wallet.update({ 
        where: { id: w.id }, 
        data: { balanceMinorUnits: { decrement: stakeAmount } } 
      });
      await tx.walletTransaction.create({ data: {
        walletId: w.id, 
        type: 'STAKE', 
        amountMinorUnits: -stakeAmount, 
        relatedMatchId: matchId
      }});
    }

    // 6. Create Match row (status: ACTIVE)
    const match = await tx.match.create({ data: {
      id: matchId,
      playerLightId: player1Id, 
      playerDarkId: player2Id,
      tier: stakeTier, 
      stakeMinorUnits: stakeAmount, 
      status: 'ACTIVE'
    }});
    
    return match;
  });
};
