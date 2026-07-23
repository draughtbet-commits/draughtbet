import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString && process.env.NODE_ENV !== 'test') {
  throw new Error('FATAL: DATABASE_URL is missing.');
}

const pool = new pg.Pool({ connectionString: connectionString || 'postgresql://localhost:5432/dummy' });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

export default prisma;
