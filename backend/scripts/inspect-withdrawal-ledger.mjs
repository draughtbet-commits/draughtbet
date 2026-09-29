// Prints the player's ledger balances per account plus every withdrawal, so a
// recorded "Available balance" can be checked against the ledger rather than
// taken on trust.
import prisma from '../src/utils/db.js';
import { getWalletBalance } from '../src/modules/wallet/service.js';

const email = process.argv[2] || 'withdraw.dev@draughtsarena.net';
const user = await prisma.user.findUnique({ where: { email } });
if (!user) {
  console.error(`no user ${email}`);
  process.exit(1);
}

const accounts = await prisma.ledgerAccount.findMany({
  where: { userId: user.id },
  include: { entries: { select: { amountMinorUnits: true } } },
});
for (const account of accounts) {
  const total = account.entries.reduce((sum, e) => sum + BigInt(e.amountMinorUnits), 0n);
  console.log(`${account.type.padEnd(24)} ${total}`);
}

const balance = await getWalletBalance(user.id);
console.log('\nGET /wallet/balance ->', balance);

const withdrawals = await prisma.withdrawal.findMany({
  where: { userId: user.id },
  orderBy: { createdAt: 'asc' },
  select: {
    id: true,
    status: true,
    amountMinorUnits: true,
    reference: true,
    failureReason: true,
    providerRef: true,
  },
});
console.log('\nwithdrawals:');
for (const w of withdrawals) {
  console.log(
    `  ${w.status.padEnd(15)} ${w.amountMinorUnits} ref=${w.reference} provider=${w.providerRef ?? '-'}` +
      `${w.failureReason ? ` reason=${w.failureReason}` : ''}`
  );
}

const inFlight = withdrawals.filter((w) => ['PENDING_REVIEW', 'APPROVED', 'PROCESSING', 'FAILED'].includes(w.status));
console.log(
  `\nfunds still reserved: ${inFlight.length} withdrawal(s) = ` +
    `${inFlight.reduce((sum, w) => sum + w.amountMinorUnits, 0n)} minor units`
);

await prisma.$disconnect();
