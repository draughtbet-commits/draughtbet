import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
const u = await prisma.user.findFirst({
  where: { email: { contains: 'arena+' } },
  orderBy: { createdAt: 'desc' },
  select: { email: true, tier: true, kycStatus: true, countryCode: true, isBanned: true, isSuspended: true, wallet: { select: { availableBalanceMinorUnits: true } } }
});
console.log('P2 rows probed');
