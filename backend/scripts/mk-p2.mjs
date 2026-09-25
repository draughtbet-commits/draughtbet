import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import bcrypt from 'bcrypt';
const cs = process.env.DATABASE_URL;
const pool = new pg.Pool({ connectionString: cs });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
const seed = await prisma.user.findUnique({ where: { email: 'seed.dev@draughtsarena.net' } });
const s = {
  tier: seed.tier, kycStatus: seed.kycStatus, countryCode: seed.countryCode,
  countryBinding: seed.countryBinding, geoBinding: seed.geoBinding, ageVerified: seed.ageVerified,
  emailVerified: true, fullName: seed.fullName, address: seed.address, dateOfBirth: seed.dateOfBirth
};
const email = 'p2.arena+' + Date.now() + '@draughtsarena.net';
const hash = bcrypt.hashSync('Arena-Match-P2-77!', 12);
const u = await prisma.user.create({ data:{
  email, username:'p2arena', passwordHash:hash, ...s, dateOfBirth: new Date('2000-05-05T00:00:00.000Z'),
  kycLevel: seed.kycLevel ?? undefined
}}).catch(async e => {
  console.error('create failed:', e.message);
  const row = await prisma.user.findFirst({ where: { countryCode: 'NG' }, take: 1 });
  return null;
});
console.log('P2 id=' + u?.id + ' email=' + email);
await pool.end();
