import { type Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { streamSSE } from 'hono/streaming';
import { ApiError, errors } from '../core/errors.js';
import { safeEqual } from '../core/ids.js';
import type { OutcomeService, Principal } from '../core/service.js';
import { a2aHandler, agentCard } from './a2a.js';
import { docsPage } from './docs.js';
import { mcpHandler } from './mcp.js';
import { jsonSchemaBundle, openApiDocument } from './openapi.js';

export interface AppOptions {
  providerName: string;
  publicUrl?: string;
  adminToken?: string;
  cronSecret?: string;
  sse?: { pollMs?: number; maxSeconds?: number };
  /** Awaited before every request (e.g. demo seeding). */
  ready?: Promise<unknown>;
}

type Env = { Variables: { principal: Principal } };
type C = Context<Env>;

const bearer = (c: C) => /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '')?.[1]?.trim();

async function readBody(c: C): Promise<unknown> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw errors.invalid('Request body must be JSON');
  }
}

const list = <T>(data: T[]) => ({ object: 'list' as const, data });

export function createApp(service: OutcomeService, opts: AppOptions) {
  const app = new Hono<Env>();
  const baseUrl = (c: C) => opts.publicUrl ?? new URL(c.req.url).origin;
  const pollMs = opts.sse?.pollMs ?? 1500;
  const maxSeconds = opts.sse?.maxSeconds ?? 25;

  app.onError((e, c) => {
    if (e instanceof ApiError) {
      if (e.status === 401) c.header('www-authenticate', 'Bearer');
      return c.json(e.toJSON(), e.status as ContentfulStatusCode);
    }
    console.error('[outcome] unhandled', e);
    return c.json({ error: { code: 'internal_error', message: 'Internal error' } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: 'not_found', message: `No route for ${c.req.method} ${c.req.path}` } }, 404));

  if (opts.ready) {
    const ready = opts.ready;
    app.use('*', async (_c, next) => {
      await ready;
      await next();
    });
  }

  // ------------------------------------------------------------ public discovery

  app.get('/', (c) => c.html(docsPage({ baseUrl: baseUrl(c), providerName: opts.providerName, capabilities: service.capabilities })));
  app.get('/healthz', (c) => c.json({ ok: true }));
  app.get('/openapi.json', (c) => c.json(openApiDocument(service.capabilities, baseUrl(c), opts.providerName)));
  app.get('/schemas/outcome.json', (c) => c.json(jsonSchemaBundle(service.capabilities, baseUrl(c))));
  const card = (c: C) => c.json(agentCard(service.capabilities, baseUrl(c), opts.providerName));
  app.get('/.well-known/agent-card.json', card);
  app.get('/.well-known/agent.json', card);
  app.get('/v1/capabilities', (c) => c.json(list(service.capabilities.describe())));

  // ------------------------------------------------------------ scheduler + admin

  app.on(['GET', 'POST'], '/cron/tick', async (c) => {
    if (opts.cronSecret && !safeEqual(bearer(c) ?? '', opts.cronSecret)) throw errors.unauthorized();
    return c.json(await service.tick());
  });

  app.use('/admin/*', async (c, next) => {
    if (!opts.adminToken) throw errors.notFound('Route');
    if (!safeEqual(bearer(c) ?? '', opts.adminToken)) throw errors.unauthorized('Invalid admin token');
    await next();
  });
  app.post('/admin/accounts', async (c) => c.json(await service.adminCreateAccount(await readBody(c)), 201));
  app.patch('/admin/accounts/:id', async (c) => c.json(await service.adminUpdateAccount(c.req.param('id'), await readBody(c))));
  app.post('/admin/operator-keys', async (c) => c.json(await service.adminCreateOperatorKey(await readBody(c)), 201));

  // ------------------------------------------------------------ authenticated surface

  const auth = async (c: C, next: () => Promise<void>) => {
    const key = bearer(c);
    const principal = key ? await service.authenticate(key) : null;
    if (!principal) throw errors.unauthorized();
    c.set('principal', principal);
    await next();
  };
  app.use('/v1/*', auth);
  app.use('/mcp', auth);
  app.use('/a2a', auth);

  app.post('/mcp', mcpHandler(service, opts.providerName));
  app.get('/mcp', (c) => c.json({ error: { code: 'method_not_allowed', message: 'Stateless MCP endpoint: POST JSON-RPC only' } }, 405));
  app.post('/a2a', a2aHandler(service));

  /** POST route with Idempotency-Key support. */
  const post = (path: string, status: ContentfulStatusCode, run: (p: Principal, body: unknown, c: C) => Promise<unknown>) =>
    app.post(path, async (c) => {
      const p = c.get('principal');
      const body = await readBody(c);
      const key = c.req.header('idempotency-key');
      if (!key) return c.json(await run(p, body, c), status);
      const res = await service.idempotent(p, key, `POST ${c.req.path}`, body, async () => ({ status, body: await run(p, body, c) }));
      if ('replayed' in res) c.header('idempotent-replayed', 'true');
      return c.json(res.body as object, res.status as ContentfulStatusCode);
    });

  // Quotes
  post('/v1/quotes', 201, (p, body) => service.createQuote(p, body));
  app.get('/v1/quotes/:id', async (c) => c.json(await service.getQuote(c.get('principal'), c.req.param('id'))));

  // Tasks
  post('/v1/tasks', 201, (p, body) => service.createTask(p, body));
  app.get('/v1/tasks', async (c) =>
    c.json(list(await service.listTasks(c.get('principal'), { status: c.req.query('status'), limit: Number(c.req.query('limit')) || undefined }))),
  );
  app.get('/v1/tasks/:id', async (c) => c.json(await service.getTask(c.get('principal'), c.req.param('id'))));
  post('/v1/tasks/:id/cancel', 200, (p, body, c) => service.cancelTask(p, c.req.param('id')!, body));
  post('/v1/tasks/:id/input', 200, (p, body, c) => service.respondInput(p, c.req.param('id')!, body));
  app.get('/v1/tasks/:id/deliveries', async (c) => c.json(list(await service.listDeliveries(c.get('principal'), c.req.param('id')))));

  app.get('/v1/tasks/:id/events', async (c) => {
    const p = c.get('principal');
    const id = c.req.param('id');
    const after = Number(c.req.query('after') ?? c.req.header('last-event-id') ?? 0) || 0;
    const wantsStream = (c.req.header('accept') ?? '').includes('text/event-stream') || c.req.query('stream') === 'true';
    if (!wantsStream) {
      const events = await service.listEvents(p, id, after, Number(c.req.query('limit')) || 100);
      return c.json({ ...list(events), next_after: events.at(-1)?.seq ?? after });
    }
    await service.listEvents(p, id, 0, 1); // access check before the stream opens
    const seconds = Math.min(Number(c.req.query('timeout')) || maxSeconds, 300);
    return streamSSE(c, async (stream) => {
      let cursor = after;
      let lastWrite = Date.now();
      const until = Date.now() + seconds * 1000;
      while (!stream.aborted && Date.now() < until) {
        const events = await service.listEvents(p, id, cursor, 100);
        for (const e of events) {
          await stream.writeSSE({ id: String(e.seq), event: e.type, data: JSON.stringify(e), retry: 2000 });
          cursor = e.seq;
          lastWrite = Date.now();
        }
        if (events.length) continue;
        if (Date.now() - lastWrite > 15_000) {
          await stream.write(': keepalive\n\n');
          lastWrite = Date.now();
        }
        await stream.sleep(pollMs);
      }
    });
  });

  // Deliveries
  app.get('/v1/deliveries/:id', async (c) => c.json(await service.getDelivery(c.get('principal'), c.req.param('id'))));
  post('/v1/deliveries/:id/accept', 200, (p, _body, c) => service.acceptDelivery(p, c.req.param('id')!));
  post('/v1/deliveries/:id/reject', 200, (p, body, c) => service.rejectDelivery(p, c.req.param('id')!, body));

  // Settlements
  app.get('/v1/settlements', async (c) =>
    c.json(list(await service.listSettlements(c.get('principal'), { task_id: c.req.query('task_id') }))),
  );

  // Mandates
  post('/v1/mandates', 201, (p, body) => service.createMandate(p, body));
  app.get('/v1/mandates', async (c) => c.json(list(await service.listMandates(c.get('principal')))));
  app.get('/v1/mandates/:id', async (c) => c.json(await service.getMandate(c.get('principal'), c.req.param('id'))));
  post('/v1/mandates/:id/revoke', 200, (p, _body, c) => service.revokeMandate(p, c.req.param('id')!));

  // Operator (fulfilment side)
  app.get('/v1/operator/tasks', async (c) => {
    const p = c.get('principal');
    if (p.role !== 'operator') throw errors.forbidden('Operator key required');
    return c.json(list(await service.listTasks(p, { status: c.req.query('status') ?? 'queued,working,needs_input' })));
  });
  post('/v1/operator/tasks/:id/start', 200, (p, body, c) => service.operatorStart(p, c.req.param('id')!, body));
  post('/v1/operator/tasks/:id/request-input', 200, (p, body, c) => service.operatorRequestInput(p, c.req.param('id')!, body));
  post('/v1/operator/tasks/:id/deliveries', 201, (p, body, c) => service.operatorDeliver(p, c.req.param('id')!, body));
  post('/v1/operator/tasks/:id/fail', 200, (p, body, c) => service.operatorFail(p, c.req.param('id')!, body));

  return app;
}
