import { describe, expect, it } from 'vitest';
import { DAY, harness, intent, mandate, task } from './helpers.js';

describe('mandates', () => {
  it('only the owner can delegate', async () => {
    const h = await harness();
    const m = await mandate(h);
    const r = await h.call('POST', '/v1/mandates', {
      key: m.agent,
      body: { scope: { outcomes: ['meeting.booked'], currency: 'gbp', max_total: 1 }, expires_at: '2030-01-01T00:00:00Z' },
    });
    expect(r.status).toBe(403);
    expect((await h.call('POST', '/v1/mandates', { key: h.operator, body: {} })).status).toBe(403);
  });

  it('blocks intents outside the ICP envelope, and warns at quote time', async () => {
    const h = await harness();
    const m = await mandate(h, { constraints: { geo: ['GB'], industries: ['fintech'] }, max_unit_price: 37_500 });
    const q = await h.call('POST', '/v1/quotes', {
      key: m.agent,
      body: intent({ constraints: { geo: ['GB', 'US'], industries: ['fintech'], titles: ['CFO'] } }),
    });
    expect(q.body.mandate_check.ok).toBe(false);
    expect(q.body.mandate_check.violations).toContain('geo: [US] outside mandate scope [GB]');
    const t = await h.call('POST', '/v1/tasks', { key: m.agent, body: { quote_id: q.body.id } });
    expect(t.status).toBe(403);
    expect(t.body.error.code).toBe('mandate_scope_violation');
  });

  it('caps spend: "spend ≤ £2k" turns 20 meetings into a 402 that says 5 fit', async () => {
    const h = await harness();
    const m = await mandate(h, { max_total: 200_000 });
    const { res } = await task(h, m.agent);
    expect(res.status).toBe(402);
    expect(res.body.error.message).toBe("Committing £7,500 would exceed the mandate's remaining £2,000");
    expect(res.body.error.details).toMatchObject({ remaining: 200_000, max_affordable_quantity: 5 });
    const { res: ok } = await task(h, m.agent, { quantity: 5 });
    expect(ok.status).toBe(201);
  });

  it('expiry stops new commitments; revocation kills the agent key', async () => {
    const h = await harness();
    const m = await mandate(h, {}, 2);
    const { task: t } = await task(h, m.agent, { quantity: 1 });
    h.clock.advance(3 * DAY);
    const { res } = await task(h, m.agent, { quantity: 1 });
    expect(res.body.error.code).toBe('mandate_inactive');
    // in-flight work stays manageable after expiry
    expect((await h.call('GET', `/v1/tasks/${t.id}`, { key: m.agent })).status).toBe(200);

    const m2 = await mandate(h);
    await h.call('POST', `/v1/mandates/${m2.id}/revoke`, { key: h.owner });
    expect((await h.call('GET', '/v1/tasks', { key: m2.agent })).status).toBe(401);
  });

  it('scopes agent visibility to its own mandate', async () => {
    const h = await harness();
    const a = await mandate(h);
    const b = await mandate(h);
    const { task: ownerTask } = await task(h, h.owner, { quantity: 1 });
    const { task: aTask } = await task(h, a.agent, { quantity: 1 });
    expect((await h.call('GET', `/v1/tasks/${ownerTask.id}`, { key: a.agent })).status).toBe(404);
    expect((await h.call('GET', `/v1/tasks/${aTask.id}`, { key: b.agent })).status).toBe(404);
    expect((await h.call('GET', `/v1/tasks/${aTask.id}`, { key: h.owner })).status).toBe(200);
    expect((await h.call('GET', '/v1/tasks', { key: a.agent })).body.data.map((t: any) => t.id)).toEqual([aTask.id]);
    expect((await h.call('GET', `/v1/mandates/${b.id}`, { key: a.agent })).status).toBe(404);
    const spoof = await h.call('POST', '/v1/tasks', { key: a.agent, body: { quote_id: 'qte_x', mandate_id: b.id } });
    expect(spoof.status).toBe(403);
  });

  it('keeps tenants apart', async () => {
    const h = await harness();
    const other = await h.call('POST', '/admin/accounts', { key: 'admin_token', body: { name: 'Other' } });
    const { task: t } = await task(h, h.owner, { quantity: 1 });
    expect((await h.call('GET', `/v1/tasks/${t.id}`, { key: other.body.owner_key })).status).toBe(404);
  });
});
