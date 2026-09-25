import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import bcrypt from 'bcrypt';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
const target = process.argv[2];
const pin = process.argv[3] || '7373';
const user = await prisma.user.findFirst({ where: { OR: [{ email: target }, { username: target }] } });
if (!user) { console.error('no user'); process.exit(1); }
const pinHash = bcrypt.hashSync(pin, 12);
await prisma.user.update({ where: { id: user.id }, data: { pinHash } });
console.log('pin set for', user.email, '('+user.id+') to', pin);
await pool.end();
