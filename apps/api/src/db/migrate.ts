import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { DEFAULT_USER_ID } from '@chess-prep/shared';
import { env } from '../env.js';
import { users } from './schema.js';

async function main() {
  const sql = postgres(env.DATABASE_URL, { max: 1 });
  const db = drizzle(sql);
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('Migrations applied.');

  // Seed the single-user-mode default user.
  await db
    .insert(users)
    .values({ id: DEFAULT_USER_ID, email: null })
    .onConflictDoNothing();
  console.log(`Default user ensured (${DEFAULT_USER_ID}).`);

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
