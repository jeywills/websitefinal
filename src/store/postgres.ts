import type { OutcomeEvent } from '../core/schemas.js';
import { type Docs, type FindOpts, type Kind, type Store, type Tx, type Where, indexOf } from './types.js';

/** Minimal client surface shared by `pg` Pool and PGlite (see test adapter). */
export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
  release(): void;
}
export interface Connector {
  connect(): Promise<SqlClient>;
  end?(): Promise<void>;
}

const SCHEMA = 'outcome';
const table = (kind: Kind) => `${SCHEMA}.${kind}`;

function txApi(c: SqlClient): Tx {
  return {
    async get<K extends Kind>(kind: K, id: string, opts?: { forUpdate?: boolean }) {
      const { rows } = await c.query(`select doc from ${table(kind)} where id = $1${opts?.forUpdate ? ' for update' : ''}`, [id]);
      return (rows[0]?.doc ?? null) as Docs[K] | null;
    },

    async insert<K extends Kind>(kind: K, doc: Docs[K]) {
      const i = indexOf(kind, doc);
      const { rows } = await c.query(
        `insert into ${table(kind)} (id, account_id, parent_id, lookup, status, due_at, doc)
         values ($1, $2, $3, $4, $5, $6::timestamptz, $7::jsonb)
         on conflict (id) do nothing returning id`,
        [doc.id, i.account_id, i.parent_id, i.lookup, i.status, i.due_at, JSON.stringify(doc)],
      );
      return rows.length === 1;
    },

    async update<K extends Kind>(kind: K, doc: Docs[K]) {
      const i = indexOf(kind, doc);
      const { rows } = await c.query(
        `update ${table(kind)} set account_id = $2, parent_id = $3, lookup = $4, status = $5,
           due_at = $6::timestamptz, doc = $7::jsonb, updated_at = now()
         where id = $1 returning id`,
        [doc.id, i.account_id, i.parent_id, i.lookup, i.status, i.due_at, JSON.stringify(doc)],
      );
      if (rows.length !== 1) throw new Error(`update of missing ${kind} ${doc.id}`);
    },

    async remove(kind, id) {
      await c.query(`delete from ${table(kind)} where id = $1`, [id]);
    },

    async find<K extends Kind>(kind: K, where: Where, opts: FindOpts = {}) {
      const clauses: string[] = [];
      const params: unknown[] = [];
      for (const col of ['account_id', 'parent_id', 'lookup'] as const) {
        if (where[col] !== undefined) {
          params.push(where[col]);
          clauses.push(`${col} = $${params.length}`);
        }
      }
      if (where.status !== undefined) {
        params.push(Array.isArray(where.status) ? where.status : [where.status]);
        clauses.push(`status = any($${params.length}::text[])`);
      }
      params.push(opts.limit ?? 100);
      const { rows } = await c.query(
        `select doc from ${table(kind)} ${clauses.length ? `where ${clauses.join(' and ')}` : ''}
         order by ord ${opts.order === 'desc' ? 'desc' : 'asc'} limit $${params.length}`,
        params,
      );
      return rows.map((r) => r.doc as Docs[K]);
    },

    async due<K extends Kind>(kind: K, now: Date, limit: number) {
      const { rows } = await c.query(
        `select doc from ${table(kind)} where due_at is not null and due_at <= $1::timestamptz order by due_at limit $2`,
        [now.toISOString(), limit],
      );
      return rows.map((r) => r.doc as Docs[K]);
    },

    async appendEvent(event) {
      const { rows } = await c.query(
        `insert into ${SCHEMA}.events (id, account_id, task_id, type, doc) values ($1, $2, $3, $4, $5::jsonb) returning seq`,
        [event.id, event.account_id, event.task_id, event.type, JSON.stringify(event)],
      );
      return { ...event, seq: Number(rows[0].seq) } as OutcomeEvent;
    },

    async events(where, afterSeq, limit) {
      const clauses = ['seq > $1'];
      const params: unknown[] = [afterSeq];
      if (where.task_id !== undefined) {
        params.push(where.task_id);
        clauses.push(`task_id = $${params.length}`);
      }
      if (where.account_id !== undefined) {
        params.push(where.account_id);
        clauses.push(`account_id = $${params.length}`);
      }
      params.push(limit);
      const { rows } = await c.query(
        `select seq, doc from ${SCHEMA}.events where ${clauses.join(' and ')} order by seq limit $${params.length}`,
        params,
      );
      return rows.map((r) => ({ ...r.doc, seq: Number(r.seq) }) as OutcomeEvent);
    },
  };
}

export class PostgresStore implements Store {
  constructor(private readonly connector: Connector) {}

  async tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.connector.connect();
    try {
      await client.query('begin');
      const result = await fn(txApi(client));
      await client.query('commit');
      return result;
    } catch (e) {
      await client.query('rollback').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.connector.end?.();
  }
}
