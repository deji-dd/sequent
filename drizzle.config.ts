import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url:
      process.env.DATABASE_URL ||
      `postgres://${process.env.POSTGRES_USER || 'sequent_user'}:${process.env.POSTGRES_PASSWORD || ''}@${
        process.env.POSTGRES_HOST === '/tmp' || !process.env.POSTGRES_HOST
          ? '127.0.0.1'
          : process.env.POSTGRES_HOST
      }:${process.env.POSTGRES_PORT || 5432}/${process.env.POSTGRES_DB || 'sequent_db'}`,
  },
});
