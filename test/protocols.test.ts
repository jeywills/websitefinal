import { describe, expect, it } from 'vitest';
import { stripeProvider } from '../src/payments/stripe.js';
import type { Settlement } from '../src/core/schemas.js';
import { harness, intent, mandate, meeting, task } from './helpers.js';

const rpc = (method: string, params?: unknown, id: number | null = 1) => ({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params });

describe('REST basics', () => {
  it('requires a key, and serves public discovery without one', async () => {
    const h = await harness();
    const r = await h.call('GET', '/v1/tasks');
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBe('Bearer');
    expect((await h.call('GET', '/v1/capabilities')).body.data[0].id).toBe('meeting.booked');
    const home = await h.call('GET', '/');
    expect(home.status).toBe(200);
    expect(home.body).toContain('<title>Test House Outcome API</title>');
    expect((await h.call('GET', '/admin/accounts', { key: 'nope' })).status).toBe(401);
  });

  it('replays POSTs with the same Idempotency-Key and rejects a changed body', async () => {
    const h = await harness();
    const q = await h.call('POST', '/v1/quotes', { key: h.owner, body: intent({ quantity: 2 }) });
    const headers = { 'idempotency-key': 'retry-123' };
    const first = await h.call('POST', '/v1/tasks', { key: h.owner, body: { quote_id: q.body.id }, headers });
    const second = await h.call('POST', '/v1/tasks', { key: h.owner, body: { quote_id: q.body.id }, headers });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    const changed = await h.call('POST', '/v1/tasks', { key: h.owner, body: { quote_id: 'qte_other' }, headers });
    expect(changed.body.error.code).toBe('idempotency_mismatch');
    // errors replay too
    const e1 = await h.call('POST', '/v1/tasks', { key: h.owner, body: { quote_id: 'qte_missing' }, headers: { 'idempotency-key': 'k2' } });
    const e2 = await h.call('POST', '/v1/tasks', { key: h.owner, body: { quote_id: 'qte_missing' }, headers: { 'idempotency-key': 'k2' } });
    expect([e1.status, e2.status]).toEqual([404, 404]);
  });

  it('rejects plain-http callbacks', async () => {
    const h = await harness();
    const { res } = await task(h, h.owner, { quantity: 1 }, { callback_url: 'http://insecure.example/hook' });
    expect(res.status).toBe(400);
  });

  it('streams task events over SSE with resumable ids', async () => {
    const h = await harness();
    const { task: t } = await task(h, h.owner, { quantity: 2 });
    await h.call('POST', `/v1/operator/tasks/${t.id}/deliveries`, { key: h.operator, body: meeting(h) });
    const res = await h.app.request(`/v1/tasks/${t.id}/events?timeout=1`, {
      headers: { authorization: `Bearer ${h.owner}`, accept: 'text/event-stream' },
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('event: task.created');
    expect(text).toContain('event: delivery.created');
    expect(text).toMatch(/^id: 1$/m);

    const resumed = await h.app.request(`/v1/tasks/${t.id}/events?timeout=1`, {
      headers: { authorization: `Bearer ${h.owner}`, accept: 'text/event-stream', 'last-event-id': '1' },
    });
    const rest = await resumed.text();
    expect(rest).not.toContain('event: task.created');
    expect(rest).toContain('event: delivery.created');

    const denied = await h.app.request(`/v1/tasks/${t.id}/events`, { headers: { authorization: `Bearer ${(await mandate(h)).agent}`, accept: 'text/event-stream' } });
    expect(denied.status).toBe(404);
  });

  it('publishes an OpenAPI 3.1 document and a JSON Schema bundle', async () => {
    const h = await harness();
    const spec = (await h.call('GET', '/openapi.json')).body;
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.servers[0].url).toBe('https://outcomes.test');
    expect(Object.keys(spec.paths)).toContain('/v1/operator/tasks/{id}/deliveries');
    expect(spec.components.schemas.Intent.properties.constraints.properties.titles).toBeDefined();
    const bundle = (await h.call('GET', '/schemas/outcome.json')).body;
    expect(Object.keys(bundle.$defs)).toEqual(expect.arrayContaining(['Intent', 'Quote', 'Task', 'Delivery', 'Settlement', 'Mandate', 'meeting.booked.result']));
  });
});

describe('MCP', () => {
  it('initialises, lists tools and runs the buy flow', async () => {
    const h = await harness();
    const m = await mandate(h);
    const call = (body: unknown) => h.call('POST', '/mcp', { key: m.agent, body });

    const init = await call(rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }));
    expect(init.body.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'outcome-api' } });
    expect((await call(rpc('notifications/initialized', undefined, null))).status).toBe(202);

    const tools = (await call(rpc('tools/list'))).body.result.tools;
    expect(tools.map((t: any) => t.name)).toEqual([
      'list_outcomes', 'get_quote', 'create_task', 'get_task', 'list_tasks',
      'respond_to_input', 'accept_delivery', 'reject_delivery', 'cancel_task', 'get_mandate',
    ]);
    for (const t of tools) expect(t.inputSchema.type).toBe('object');
    expect(tools.find((t: any) => t.name === 'get_quote').inputSchema.properties.intent.properties.budget).toBeDefined();

    const quote = (await call(rpc('tools/call', { name: 'get_quote', arguments: { intent: intent({ quantity: 4 }) } }))).body.result;
    expect(quote.isError).toBe(false);
    expect(quote.structuredContent.feasibility.status).toBe('feasible');
    const created = (await call(rpc('tools/call', { name: 'create_task', arguments: { quote_id: quote.structuredContent.id } }))).body.result;
    expect(created.structuredContent).toMatchObject({ status: 'queued', mandate_id: m.id });
    const got = (await call(rpc('tools/call', { name: 'get_task', arguments: { task_id: created.structuredContent.id } }))).body.result;
    expect(got.structuredContent.deliveries).toEqual([]);
    const budget = (await call(rpc('tools/call', { name: 'get_mandate', arguments: {} }))).body.result;
    expect(budget.structuredContent).toMatchObject({ reserved: 150_000 });

    const bad = (await call(rpc('tools/call', { name: 'get_task', arguments: { task_id: 'tsk_nope' } }))).body.result;
    expect(bad.isError).toBe(true);
    expect(JSON.parse(bad.content[0].text).error.code).toBe('not_found');
    expect((await call(rpc('resources/list'))).body.error.code).toBe(-32601);
    expect((await h.call('POST', '/mcp', { body: rpc('tools/list') })).status).toBe(401);
  });
});

describe('A2A', () => {
  it('serves an agent card and maps outcome tasks onto A2A tasks', async () => {
    const h = await harness();
    const card = (await h.call('GET', '/.well-known/agent-card.json')).body;
    expect(card).toMatchObject({ protocolVersion: '0.3.0', url: 'https://outcomes.test/a2a', preferredTransport: 'JSONRPC' });
    expect(card.skills[0].id).toBe('meeting.booked');

    const m = await mandate(h);
    const a2a = (method: string, params: unknown) => h.call('POST', '/a2a', { key: m.agent, body: rpc(method, params) });
    const msg = (data: unknown, taskId?: string) => ({ message: { role: 'user', messageId: 'm1', ...(taskId ? { taskId } : {}), parts: [{ kind: 'data', data }] } });

    const quoted = (await a2a('message/send', msg({ action: 'quote', intent: intent({ quantity: 3 }) }))).body.result;
    expect(quoted.kind).toBe('message');
    const quote = quoted.parts.find((p: any) => p.kind === 'data').data;

    const created = (await a2a('message/send', msg({ action: 'create_task', quote_id: quote.id }))).body.result;
    expect(created).toMatchObject({ kind: 'task', status: { state: 'submitted' }, metadata: { outcome_status: 'queued' } });

    await h.call('POST', `/v1/operator/tasks/${created.id}/request-input`, { key: h.operator, body: { question: 'Exclude current customers?', fields: [{ name: 'domains' }] } });
    const waiting = (await a2a('tasks/get', { id: created.id })).body.result;
    expect(waiting.status.state).toBe('input-required');
    const req = waiting.status.message.parts.find((p: any) => p.kind === 'data').data.input_request;

    const resumed = (await a2a('message/send', msg({ request_id: req.id, answers: { domains: ['acme.co.uk'] } }, created.id))).body.result;
    expect(resumed.status.state).toBe('working');

    const d = (await h.call('POST', `/v1/operator/tasks/${created.id}/deliveries`, { key: h.operator, body: meeting(h) })).body;
    const accepted = (await a2a('message/send', msg({ action: 'accept_delivery', delivery_id: d.id }))).body.result;
    expect(accepted.artifacts[0]).toMatchObject({ artifactId: d.id, parts: [{ kind: 'data', data: { status: 'accepted' } }] });

    expect((await a2a('tasks/cancel', { id: created.id })).body.result.status.state).toBe('canceled');
    expect((await a2a('tasks/cancel', { id: created.id })).body.error.code).toBe(-32002);
    expect((await a2a('tasks/get', { id: 'tsk_nope' })).body.error.code).toBe(-32001);
    expect((await a2a('message/send', { message: { parts: [{ kind: 'text', text: 'book me meetings' }] } })).body.error.code).toBe(-32602);
  });
});

describe('Stripe settlement', () => {
  const settlement: Settlement = {
    id: 'stl_1', object: 'settlement', account_id: 'acct_1', task_id: 'tsk_1', delivery_id: 'dlv_1', mandate_id: null,
    amount: 37_500, currency: 'gbp', status: 'pending', provider: 'stripe', provider_ref: null, attempts: 0,
    last_error: null, next_attempt_at: null, created_at: '', updated_at: '',
  };
  const account = { id: 'acct_1', object: 'account' as const, name: 'A', stripe_customer_id: 'cus_123', webhook_secret: 'x', created_at: '' };

  it('creates an idempotent invoice item per accepted unit', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ id: 'ii_1' }), { status: 200 });
    }) as unknown as typeof fetch;
    const res = await stripeProvider('sk_test_x', fake).charge({ settlement, account, description: 'meeting.booked: Jane, CFO' });
    expect(res).toEqual({ ok: true, ref: 'ii_1' });
    expect(seen!.url).toBe('https://api.stripe.com/v1/invoiceitems');
    const headers = new Headers(seen!.init.headers);
    expect(headers.get('idempotency-key')).toBe('outcome_stl_1');
    const body = new URLSearchParams(String(seen!.init.body));
    expect(Object.fromEntries(body)).toMatchObject({ customer: 'cus_123', amount: '37500', currency: 'gbp', 'metadata[delivery_id]': 'dlv_1' });
  });

  it('fails cleanly without a customer or on Stripe errors, and the service retries', async () => {
    const p = stripeProvider('sk_test_x', (async () => new Response(JSON.stringify({ error: { message: 'card_declined' } }), { status: 402 })) as unknown as typeof fetch);
    expect(await p.charge({ settlement, account: { ...account, stripe_customer_id: null }, description: '' })).toMatchObject({ ok: false });
    expect(await p.charge({ settlement, account, description: '' })).toEqual({ ok: false, error: 'card_declined' });

    let attempts = 0;
    const flaky = { name: 'flaky', charge: async () => (++attempts === 1 ? { ok: false as const, error: 'timeout' } : { ok: true as const, ref: 'ref_2' }) };
    const h = await harness('memory', { payments: flaky });
    const { task: t } = await task(h, h.owner, { quantity: 1 });
    const d = (await h.call('POST', `/v1/operator/tasks/${t.id}/deliveries`, { key: h.operator, body: meeting(h) })).body;
    await h.call('POST', `/v1/deliveries/${d.id}/accept`, { key: h.owner });
    await h.service.drain();
    let s = (await h.call('GET', '/v1/settlements', { key: h.owner })).body.data[0];
    expect(s).toMatchObject({ status: 'failed', attempts: 1, last_error: 'timeout' });
    h.clock.advance(2 * 60_000);
    await h.call('POST', '/cron/tick', { headers: { authorization: 'Bearer cron_secret' } });
    s = (await h.call('GET', '/v1/settlements', { key: h.owner })).body.data[0];
    expect(s).toMatchObject({ status: 'succeeded', attempts: 2, provider_ref: 'ref_2', next_attempt_at: null });
  });
});
