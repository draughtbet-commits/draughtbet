import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
const users = await prisma.user.findMany({
  where: { email: { contains: 'arena+' } },
  select: { email:true, tier:true, kycStatus:true, countryCode:true, isBanned:true, isSuspended:true,
    wallet: { select: { availableBalanceMinorUnits:true } } }
});
for (const u of users) console.log(JSON.stringify({...u, email:(u.email||'').replace(/\+.*@/,'***@')}));
await pool.end();
