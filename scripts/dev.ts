import { serve } from '@hono/node-server';
import { DEMO_KEYS, createFromEnv } from '../src/deps.js';
import { createApp } from '../src/http/app.js';

const port = Number(process.env.PORT) || 8787;
const { service, options, storeKind, seeded } = createFromEnv();
const app = createApp(service, options);

serve({ fetch: app.fetch, port }, () => {
  console.log(`Outcome API on http://localhost:${port} (store: ${storeKind})`);
  if (seeded) console.log(`Demo keys  owner: ${DEMO_KEYS.owner}  operator: ${DEMO_KEYS.operator}`);
});
