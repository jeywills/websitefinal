import { PGlite } from '@electric-sql/pglite';
import { defaultCapabilities } from '../src/core/capabilities/index.js';
import { OutcomeService } from '../src/core/service.js';
import { createApp } from '../src/http/app.js';
import { ledgerProvider } from '../src/payments/ledger.js';
import type { PaymentProvider } from '../src/payments/types.js';
import { MemoryStore } from '../src/store/memory.js';
import { migrate } from '../src/store/migrate.js';
import { type Connector, PostgresStore } from '../src/store/postgres.js';

export type StoreKind = 'memory' | 'postgres';
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** PGlite is single-connection: serialise "connections" so transactions don't interleave. */
export function pgliteConnector(db: PGlite): Connector {
  let chain = Promise.resolve();
  return {
    async connect() {
      let release!: () => void;
      const mine = new Promise<void>((r) => (release = r));
      const prev = chain;
      chain = chain.then(() => mine);
      await prev;
      return {
        query: async (text: string, params?: unknown[]) =>
          params?.length ? db.query(text, params) : { rows: (await db.exec(text)).at(-1)?.rows ?? [] },
        release,
      };
    },
  };
}

export interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export async function harness(kind: StoreKind = 'memory', opts: { payments?: PaymentProvider } = {}) {
  let now = new Date('2026-10-19T09:00:00.000Z');
  const clock = {
    now: () => new Date(now),
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
  };
  const sent: Sent[] = [];
  const fetchMock = (async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers).entries()), body: String(init.body) });
    return new Response('ok');
  }) as unknown as typeof fetch;

  let close = async () => {};
  let store;
  if (kind === 'postgres') {
    const db = new PGlite();
    const connector = pgliteConnector(db);
    await migrate(connector);
    store = new PostgresStore(connector);
    close = () => db.close();
  } else {
    store = new MemoryStore();
  }

  const service = new OutcomeService({
    store,
    payments: opts.payments ?? ledgerProvider,
    capabilities: defaultCapabilities(),
    config: {
      operatorWebhookUrl: 'https://ops.example/hook',
      operatorWebhookSecret: 'whsec_ops',
      quoteTtlHours: 24,
      allowInsecureCallbacks: false,
    },
    clock: clock.now,
    fetch: fetchMock,
  });
  const app = createApp(service, {
    providerName: 'Test House',
    publicUrl: 'https://outcomes.test',
    adminToken: 'admin_token',
    cronSecret: 'cron_secret',
    sse: { pollMs: 20, maxSeconds: 1 },
  });

  const call = async (method: string, path: string, o: { key?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const res = await app.request(path, {
      method,
      headers: {
        ...(o.key ? { authorization: `Bearer ${o.key}` } : {}),
        ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...o.headers,
      },
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    });
    const text = await res.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {}
    return { status: res.status, body, headers: res.headers };
  };

  const account = await call('POST', '/admin/accounts', { key: 'admin_token', body: { name: 'Acme Fintech Ltd' } });
  const op = await call('POST', '/admin/operator-keys', { key: 'admin_token', body: { label: 'n8n' } });

  return {
    app,
    service,
    call,
    clock,
    sent,
    close,
    owner: account.body.owner_key as string,
    operator: op.body.key as string,
    accountId: account.body.account.id as string,
    webhookSecret: account.body.webhook_secret as string,
  };
}

export type Harness = Awaited<ReturnType<typeof harness>>;

export const intent = (over: Record<string, unknown> = {}) => ({
  outcome: 'meeting.booked',
  quantity: 20,
  constraints: { geo: ['GB'], industries: ['fintech'], titles: ['CFO', 'COO'] },
  budget: { currency: 'gbp', max_unit_price: 37_500 },
  brief: 'Embedded lending for UK fintechs',
  ...over,
});

let n = 0;
export function meeting(h: Harness, over: { company?: Record<string, unknown>; attendee?: Record<string, unknown>; inDays?: number } = {}) {
  n += 1;
  const at = new Date(h.clock.now().getTime() + (over.inDays ?? 3) * DAY).toISOString();
  return {
    result: {
      attendee: { name: `Prospect ${n}`, title: 'Chief Financial Officer', email: `p${n}@co${n}.co.uk`, ...over.attendee },
      company: { name: `Co ${n}`, domain: `co${n}.co.uk`, country: 'GB', industry: 'FinTech', employees: 220, ...over.company },
      scheduled_at: at,
      duration_minutes: 30,
    },
    evidence: [
      { type: 'calendar_invite', uri: `https://calendar.example/e/${n}`, sha256: 'a'.repeat(64) },
      { type: 'email_thread', description: 'Reply to step 3 of sequence' },
    ],
  };
}

export async function mandate(h: Harness, scope: Record<string, unknown> = {}, expiresInDays = 30) {
  const r = await h.call('POST', '/v1/mandates', {
    key: h.owner,
    body: {
      label: 'Outbound agent',
      scope: { outcomes: ['meeting.booked'], currency: 'gbp', max_total: 750_000, ...scope },
      expires_at: new Date(h.clock.now().getTime() + expiresInDays * DAY).toISOString(),
    },
  });
  if (r.status !== 201) throw new Error(`mandate: ${r.status} ${JSON.stringify(r.body)}`);
  return { id: r.body.mandate.id as string, agent: r.body.agent_key as string };
}

/** Quote + commit in one go. */
export async function task(h: Harness, key: string, over: Record<string, unknown> = {}, taskBody: Record<string, unknown> = {}) {
  const q = await h.call('POST', '/v1/quotes', { key, body: intent(over) });
  if (q.status !== 201) throw new Error(`quote: ${q.status} ${JSON.stringify(q.body)}`);
  const t = await h.call('POST', '/v1/tasks', { key, body: { quote_id: q.body.id, ...taskBody } });
  return { quote: q.body, res: t, task: t.body };
}
