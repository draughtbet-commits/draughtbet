import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
const p2 = await prisma.user.findFirst({ where: { email: { startsWith: 'p2.arena' } } });
const seed = await prisma.user.findFirst({ where: { tier: 'AMATEUR', wallet: { isNot: null } } });
if (!p2?.walletId) {
  const w = await prisma.wallet.create({ data: { availableBalanceMinorUnits: 1000000, user: { connect: { id: p2.id } } } });
  console.log('wallet created', w.id);
}
const wa = await prisma.wallet.findUnique({ where: { userId: p2.id } });
if (!wa?.ledgerAccountId) {
  const la = await prisma.ledgerAccount.create({ data: { availableBalanceMinorUnits: 1000000, wallet: { connect: { id: wa.id } } } });
  console.log('ledger created', la.id);
}
await pool.end();
