import { defineConfig } from '@prisma/config';
export default defineConfig({
  earlyAccess: true,
  migrations: {
    connectionString: process.env.DATABASE_URL,
  },
});
