import { waitUntil } from '@vercel/functions';
import pg from 'pg';
import { defaultCapabilities } from './core/capabilities/index.js';
import { OutcomeService } from './core/service.js';
import type { AppOptions } from './http/app.js';
import { ledgerProvider } from './payments/ledger.js';
import { stripeProvider } from './payments/stripe.js';
import { MemoryStore } from './store/memory.js';
import { PostgresStore } from './store/postgres.js';
import type { Store } from './store/types.js';

export const DEMO_KEYS = { owner: 'ok_demo_owner', operator: 'ok_demo_operator' };

type Env = Record<string, string | undefined>;

export function storeFromEnv(env: Env): { store: Store; kind: 'postgres' | 'memory' } {
  if (env.DATABASE_URL) {
    const pool = new pg.Pool({
      connectionString: env.DATABASE_URL,
      max: Number(env.DATABASE_POOL_MAX) || 5,
      ...(env.DATABASE_CA_CERT ? { ssl: { ca: env.DATABASE_CA_CERT.replace(/\\n/g, '\n') } } : {}),
    });
    return { store: new PostgresStore(pool), kind: 'postgres' };
  }
  const production = env.VERCEL_ENV === 'production' || env.NODE_ENV === 'production';
  if (production && env.OUTCOME_ALLOW_MEMORY_STORE !== '1') {
    throw new Error('DATABASE_URL is required in production (the memory store loses data between serverless instances)');
  }
  return { store: new MemoryStore(), kind: 'memory' };
}

export function createFromEnv(env: Env = process.env) {
  if (env.OPERATOR_WEBHOOK_URL && !env.OPERATOR_WEBHOOK_SECRET) {
    throw new Error('OPERATOR_WEBHOOK_SECRET is required when OPERATOR_WEBHOOK_URL is set');
  }
  const { store, kind } = storeFromEnv(env);
  const service = new OutcomeService({
    store,
    payments: env.STRIPE_SECRET_KEY ? stripeProvider(env.STRIPE_SECRET_KEY) : ledgerProvider,
    capabilities: defaultCapabilities(),
    config: {
      operatorWebhookUrl: env.OPERATOR_WEBHOOK_URL,
      operatorWebhookSecret: env.OPERATOR_WEBHOOK_SECRET,
      quoteTtlHours: Number(env.QUOTE_TTL_HOURS) || 24,
      allowInsecureCallbacks: kind === 'memory' || env.OUTCOME_ALLOW_HTTP_CALLBACKS === '1',
    },
    defer: (p) => waitUntil(p),
  });
  const seed = kind === 'memory' && env.OUTCOME_SEED_DEMO !== '0';
  const options: AppOptions = {
    providerName: env.PROVIDER_NAME ?? 'Revenue House',
    publicUrl: env.PUBLIC_BASE_URL?.replace(/\/$/, ''),
    adminToken: env.OUTCOME_ADMIN_TOKEN,
    cronSecret: env.CRON_SECRET,
    ready: seed ? service.seedDemo(DEMO_KEYS) : undefined,
  };
  return { service, options, storeKind: kind, seeded: seed };
}
