// Funds an existing user's wallet via the real ledger path
// (postDepositCredit) so GET /wallet/balance and the wallet_updated
// socket push reflect it. Idempotent per reference.
//
//   node --env-file=.env scripts/fund-user.mjs <email> <amountMinorUnits> [reference]
//
// Examples:
//   node --env-file=.env scripts/fund-user.mjs seed.dev@draughtsarena.net 250000
//   node --env-file=.env scripts/fund-user.mjs seed.dev@draughtsarena.net 250000 local-dev-seed
import prisma from '../src/utils/db.js';
import { postDepositCredit } from '../src/services/ledgerService.js';

const [email, amountMinorUnits, reference] = process.argv.slice(2);
if (!email || !amountMinorUnits) {
  console.error('usage: node --env-file=.env scripts/fund-user.mjs <email> <amountMinorUnits> [reference]');
  process.exit(2);
}

const user = await prisma.user.findUnique({ where: { email } });
if (!user) {
  console.error(`no user with email ${email}`);
  process.exit(1);
}

await prisma.wallet.create({ data: { userId: user.id } }).catch(() => {});

const ref = reference ?? `dev-seed-${Date.now()}`;
await postDepositCredit(prisma, {
  userId: user.id,
  amountMinorUnits: BigInt(amountMinorUnits),
  reference: ref,
});

console.log(`funded ${email} (${user.id}) +${amountMinorUnits} minor units (NGN)`);
await prisma.$disconnect();