import pg from 'pg';
import { migrate } from '../src/store/migrate.js';

if (!process.env.DATABASE_URL) {
  console.error('Set DATABASE_URL');
  process.exit(1);
}
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ...(process.env.DATABASE_CA_CERT ? { ssl: { ca: process.env.DATABASE_CA_CERT.replace(/\\n/g, '\n') } } : {}),
});
const applied = await migrate(pool, console.log);
console.log(applied.length ? `Done: ${applied.length} migration(s)` : 'Up to date');
await pool.end();
