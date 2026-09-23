const TODAY = () => new Date().toISOString().slice(0, 10);

/**
 * SaferPlayDailyUsage — a per-user, per-day, per-currency accumulator for the
 * money committed through the platform (deposits accepted, stakes reserved).
 * Written inside the caller's transaction as a by-product of the money move;
 * never a gating read by itself (the safer-play limits compute their own
 * windows). Idempotent by construction: the deposit path only calls it after
 * the CAS credit won, and stake reserves only after a NEW reservation row.
 */
export async function recordDailyUsage(tx, { userId, currency, depositCommittedMinorUnits = 0n, stakeCommittedMinorUnits = 0n }) {
  const usageDate = TODAY();
  return tx.saferPlayDailyUsage.upsert({
    where: { userId_usageDate_currency: { userId, usageDate, currency } },
    create: {
      userId,
      usageDate,
      currency,
      depositCommittedMinorUnits,
      stakeCommittedMinorUnits
    },
    update: {
      depositCommittedMinorUnits: { increment: depositCommittedMinorUnits },
      stakeCommittedMinorUnits: { increment: stakeCommittedMinorUnits }
    }
  });
}

export default recordDailyUsage;