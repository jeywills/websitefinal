import { readFile, readdir } from 'node:fs/promises';
import type { Connector } from './postgres.js';

const DIR = new URL('../../db/migrations/', import.meta.url);

/** Applies db/migrations/*.sql in name order, once each. */
export async function migrate(connector: Connector, log: (msg: string) => void = () => {}): Promise<string[]> {
  const c = await connector.connect();
  const applied: string[] = [];
  try {
    await c.query('create schema if not exists outcome');
    await c.query(
      'create table if not exists outcome.schema_migrations (version text primary key, applied_at timestamptz not null default now())',
    );
    const done = new Set((await c.query('select version from outcome.schema_migrations')).rows.map((r) => r.version as string));
    const files = (await readdir(DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(new URL(file, DIR), 'utf8');
      await c.query('begin');
      try {
        await c.query(sql);
        await c.query('insert into outcome.schema_migrations (version) values ($1)', [file]);
        await c.query('commit');
      } catch (e) {
        await c.query('rollback');
        throw e;
      }
      applied.push(file);
      log(`applied ${file}`);
    }
    return applied;
  } finally {
    c.release();
  }
}
