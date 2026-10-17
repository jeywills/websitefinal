import type { OutcomeEvent } from '../core/schemas.js';
import { type Docs, type FindOpts, type IndexCols, KINDS, type Kind, type Store, type Tx, type Where, indexOf } from './types.js';

interface Row {
  doc: unknown;
  idx: IndexCols;
}

interface State {
  tables: Map<Kind, Map<string, Row>>;
  events: OutcomeEvent[];
  seq: number;
}

const matches = (idx: IndexCols, where: Where) =>
  (where.account_id === undefined || idx.account_id === where.account_id) &&
  (where.parent_id === undefined || idx.parent_id === where.parent_id) &&
  (where.lookup === undefined || idx.lookup === where.lookup) &&
  (where.status === undefined ||
    (Array.isArray(where.status) ? where.status.includes(idx.status ?? '') : idx.status === where.status));

/**
 * In-process store for local dev and tests. Transactions are serialised and
 * roll back by snapshot. Not for serverless production: each instance has its own memory.
 */
export class MemoryStore implements Store {
  private state: State = { tables: new Map(KINDS.map((k) => [k, new Map()])), events: [], seq: 0 };
  private queue: Promise<unknown> = Promise.resolve();

  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const run = async () => {
      const snapshot = structuredClone(this.state);
      try {
        return await fn(this.txApi());
      } catch (e) {
        this.state = snapshot;
        throw e;
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private table(kind: Kind) {
    return this.state.tables.get(kind)!;
  }

  private txApi(): Tx {
    return {
      get: async <K extends Kind>(kind: K, id: string) => {
        const row = this.table(kind).get(id);
        return row ? (structuredClone(row.doc) as Docs[K]) : null;
      },
      insert: async <K extends Kind>(kind: K, doc: Docs[K]) => {
        const t = this.table(kind);
        if (t.has(doc.id)) return false;
        t.set(doc.id, { doc: structuredClone(doc), idx: indexOf(kind, doc) });
        return true;
      },
      update: async <K extends Kind>(kind: K, doc: Docs[K]) => {
        const t = this.table(kind);
        if (!t.has(doc.id)) throw new Error(`update of missing ${kind} ${doc.id}`);
        t.set(doc.id, { doc: structuredClone(doc), idx: indexOf(kind, doc) });
      },
      remove: async (kind, id) => {
        this.table(kind).delete(id);
      },
      find: async <K extends Kind>(kind: K, where: Where, opts: FindOpts = {}) => {
        let rows = [...this.table(kind).values()].filter((r) => matches(r.idx, where));
        if (opts.order === 'desc') rows = rows.reverse();
        return rows.slice(0, opts.limit ?? 100).map((r) => structuredClone(r.doc) as Docs[K]);
      },
      due: async <K extends Kind>(kind: K, now: Date, limit: number) =>
        [...this.table(kind).values()]
          .filter((r) => r.idx.due_at !== null && new Date(r.idx.due_at).getTime() <= now.getTime())
          .sort((a, b) => a.idx.due_at!.localeCompare(b.idx.due_at!))
          .slice(0, limit)
          .map((r) => structuredClone(r.doc) as Docs[K]),
      appendEvent: async (event) => {
        const e = { ...event, seq: ++this.state.seq } as OutcomeEvent;
        this.state.events.push(structuredClone(e));
        return e;
      },
      events: async (where, afterSeq, limit) =>
        this.state.events
          .filter(
            (e) =>
              e.seq > afterSeq &&
              (where.task_id === undefined || e.task_id === where.task_id) &&
              (where.account_id === undefined || e.account_id === where.account_id),
          )
          .slice(0, limit)
          .map((e) => structuredClone(e)),
    };
  }
}
