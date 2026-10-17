import type {
  Account,
  ApiKey,
  Delivery,
  IdempotencyRecord,
  MandateDoc,
  OutcomeEvent,
  Quote,
  Settlement,
  Task,
  WebhookDelivery,
} from '../core/schemas.js';
import { isOpen } from '../core/state.js';

export interface Docs {
  accounts: Account;
  api_keys: ApiKey;
  mandates: MandateDoc;
  quotes: Quote;
  tasks: Task;
  deliveries: Delivery;
  settlements: Settlement;
  webhooks: WebhookDelivery;
  idempotency_keys: IdempotencyRecord;
}
export type Kind = keyof Docs;
export const KINDS = [
  'accounts',
  'api_keys',
  'mandates',
  'quotes',
  'tasks',
  'deliveries',
  'settlements',
  'webhooks',
  'idempotency_keys',
] as const satisfies readonly Kind[];

/** Columns every doc table carries for querying. `due_at` drives the scheduler. */
export interface IndexCols {
  account_id: string | null;
  parent_id: string | null;
  lookup: string | null;
  status: string | null;
  due_at: string | null;
}

export function indexOf<K extends Kind>(kind: K, doc: Docs[K]): IndexCols {
  const d = doc as Docs[Kind];
  const none: IndexCols = { account_id: null, parent_id: null, lookup: null, status: null, due_at: null };
  switch (kind) {
    case 'accounts':
      return { ...none, account_id: d.id };
    case 'api_keys': {
      const k = d as ApiKey;
      return { ...none, account_id: k.account_id, parent_id: k.mandate_id, lookup: k.key_hash, status: k.status };
    }
    case 'mandates': {
      const m = d as MandateDoc;
      return { ...none, account_id: m.account_id, status: m.status };
    }
    case 'quotes': {
      const q = d as Quote;
      return { ...none, account_id: q.account_id, status: q.status, due_at: q.status === 'open' ? q.expires_at : null };
    }
    case 'tasks': {
      const t = d as Task;
      return { ...none, account_id: t.account_id, parent_id: t.mandate_id, status: t.status, due_at: isOpen(t.status) ? t.deadline : null };
    }
    case 'deliveries': {
      const x = d as Delivery;
      return {
        ...none,
        account_id: x.account_id,
        parent_id: x.task_id,
        status: x.status,
        due_at: x.status === 'pending_acceptance' ? x.acceptance_window_ends_at : null,
      };
    }
    case 'settlements': {
      const s = d as Settlement;
      return { ...none, account_id: s.account_id, parent_id: s.task_id, status: s.status, due_at: s.next_attempt_at };
    }
    case 'webhooks': {
      const w = d as WebhookDelivery;
      return { ...none, account_id: w.account_id, parent_id: w.event_id, status: w.status, due_at: w.next_attempt_at };
    }
    case 'idempotency_keys': {
      const i = d as IdempotencyRecord;
      return { ...none, account_id: i.account_id, status: i.status };
    }
  }
  return none;
}

export interface Where {
  account_id?: string;
  parent_id?: string;
  lookup?: string;
  status?: string | string[];
}

export interface FindOpts {
  limit?: number;
  order?: 'asc' | 'desc';
}

export interface Tx {
  get<K extends Kind>(kind: K, id: string, opts?: { forUpdate?: boolean }): Promise<Docs[K] | null>;
  /** Returns false if the id already exists. */
  insert<K extends Kind>(kind: K, doc: Docs[K]): Promise<boolean>;
  update<K extends Kind>(kind: K, doc: Docs[K]): Promise<void>;
  remove(kind: Kind, id: string): Promise<void>;
  find<K extends Kind>(kind: K, where: Where, opts?: FindOpts): Promise<Docs[K][]>;
  /** Docs whose due_at has passed, oldest first. */
  due<K extends Kind>(kind: K, now: Date, limit: number): Promise<Docs[K][]>;
  appendEvent(event: Omit<OutcomeEvent, 'seq'>): Promise<OutcomeEvent>;
  events(where: { task_id?: string; account_id?: string }, afterSeq: number, limit: number): Promise<OutcomeEvent[]>;
}

export interface Store {
  /** Runs fn atomically. Lock order inside: task → delivery → mandate. */
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}
