import { afterEach, describe, expect, it } from 'vitest';
import { verify } from '../src/webhooks.js';
import { DAY, HOUR, type Harness, type StoreKind, harness, intent, mandate, meeting, task } from './helpers.js';

describe.each<StoreKind>(['memory', 'postgres'])('lifecycle on %s store', (kind) => {
  let h: Harness;
  afterEach(async () => h?.close());

  it('runs intent → quote → task → needs_input → deliveries → settlement under a mandate', async () => {
    h = await harness(kind);
    const m = await mandate(h, { constraints: { geo: ['GB'], industries: ['fintech'] } });

    // Quote: agent sees whether its mandate covers it before committing
    const { quote, res, task: t } = await task(h, m.agent, {}, { callback_url: 'https://buyer.example/hooks' });
    expect(quote.mandate_check).toMatchObject({ ok: true, remaining: 750_000, max_affordable_quantity: 20 });
    expect(res.status).toBe(201);
    expect(t).toMatchObject({
      status: 'queued',
      mandate_id: m.id,
      quantity: 20,
      unit_amount: 37_500,
      billing: { committed: 750_000, settled: 0 },
      progress: { pending: 0, accepted: 0, rejected: 0, remaining: 20 },
    });
    expect((await h.call('GET', `/v1/mandates/${m.id}`, { key: m.agent })).body).toMatchObject({ reserved: 750_000, spent: 0, remaining: 0 });

    // A quote converts once
    const again = await h.call('POST', '/v1/tasks', { key: m.agent, body: { quote_id: quote.id } });
    expect(again.body.error.code).toBe('quote_already_accepted');

    // Operator works it, asks for input, buyer answers
    const op = h.operator;
    expect((await h.call('POST', `/v1/operator/tasks/${t.id}/start`, { key: op })).body.status).toBe('working');
    const asked = await h.call('POST', `/v1/operator/tasks/${t.id}/request-input`, {
      key: op,
      body: { question: 'Which calendar should meetings land on?', fields: [{ name: 'booking_link' }] },
    });
    expect(asked.body.status).toBe('needs_input');
    const req = asked.body.input_requests[0];
    const missing = await h.call('POST', `/v1/tasks/${t.id}/input`, { key: m.agent, body: { request_id: req.id, answers: {} } });
    expect(missing.body.error.details.missing).toEqual(['booking_link']);
    const answered = await h.call('POST', `/v1/tasks/${t.id}/input`, {
      key: m.agent,
      body: { request_id: req.id, answers: { booking_link: 'https://cal.com/acme/intro' } },
    });
    expect(answered.body.status).toBe('working');

    // Off-ICP delivery is refused at the door with the failing checks
    const offIcp = await h.call('POST', `/v1/operator/tasks/${t.id}/deliveries`, { key: op, body: meeting(h, { company: { country: 'US' } }) });
    expect(offIcp.status).toBe(422);
    expect(offIcp.body.error.code).toBe('delivery_nonconforming');
    expect(offIcp.body.error.details.checks.find((c: any) => c.name === 'icp.geo').result).toBe('fail');

    const noInvite = meeting(h);
    noInvite.evidence = noInvite.evidence.filter((e) => e.type !== 'calendar_invite');
    expect((await h.call('POST', `/v1/operator/tasks/${t.id}/deliveries`, { key: op, body: noInvite })).status).toBe(422);

    // Two good meetings, 3 and 5 days out
    const d1 = (await h.call('POST', `/v1/operator/tasks/${t.id}/deliveries`, { key: op, body: meeting(h, { inDays: 3 }) })).body;
    const m2 = meeting(h, { inDays: 5, attendee: { title: 'VP Finance' } });
    const d2res = await h.call('POST', `/v1/operator/tasks/${t.id}/deliveries`, { key: op, body: m2 });
    expect(d2res.status).toBe(201);
    const d2 = d2res.body;
    expect(d2.checks.find((c: any) => c.name === 'icp.title').result).toBe('warn');
    // Window anchors on the meeting, not the booking: 72h after it ends
    const meetingEnd = new Date(m2.result.scheduled_at).getTime() + 30 * 60_000;
    expect(d2.acceptance_window_ends_at).toBe(new Date(meetingEnd + 72 * HOUR).toISOString());

    // Duplicate company is refused
    const dup = await h.call('POST', `/v1/operator/tasks/${t.id}/deliveries`, {
      key: op,
      body: meeting(h, { company: { domain: `www.${m2.result.company.domain}` } }),
    });
    expect(dup.body.error.details.checks.find((c: any) => c.name === 'dedupe').result).toBe('fail');

    // Buyer rejects the first as a no-show: not billed
    h.clock.advance(4 * DAY);
    const rej = await h.call('POST', `/v1/deliveries/${d1.id}/reject`, { key: m.agent, body: { reason_code: 'no_show', note: 'Did not join' } });
    expect(rej.body).toMatchObject({ status: 'rejected', decision: { by: 'buyer', reason_code: 'no_show' }, settlement_id: null });
    expect((await h.call('POST', `/v1/deliveries/${d1.id}/accept`, { key: m.agent })).body.error.code).toBe('invalid_state');

    // Silence past the window = acceptance (lazy, on read)
    h.clock.advance(5 * DAY);
    const after = (await h.call('GET', `/v1/tasks/${t.id}`, { key: m.agent })).body;
    expect(after.progress).toEqual({ pending: 0, accepted: 1, rejected: 1, remaining: 19 });
    expect(after.billing).toEqual({ committed: 750_000, settled: 37_500 });
    const auto = after.deliveries.find((d: any) => d.id === d2.id);
    expect(auto.decision).toMatchObject({ by: 'system', note: 'Acceptance window elapsed' });

    await h.service.drain();
    const settlements = (await h.call('GET', `/v1/settlements?task_id=${t.id}`, { key: m.agent })).body.data;
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({ amount: 37_500, currency: 'gbp', status: 'succeeded', provider: 'ledger', delivery_id: d2.id });
    expect((await h.call('GET', `/v1/mandates/${m.id}`, { key: h.owner })).body).toMatchObject({ spent: 37_500, reserved: 712_500, remaining: 0 });

    // Cancelling releases everything not yet earned
    const cancelled = await h.call('POST', `/v1/tasks/${t.id}/cancel`, { key: h.owner, body: { note: 'Pausing campaign' } });
    expect(cancelled.body).toMatchObject({ status: 'cancelled', billing: { committed: 37_500, settled: 37_500 } });
    expect((await h.call('GET', `/v1/mandates/${m.id}`, { key: h.owner })).body).toMatchObject({ spent: 37_500, reserved: 0, remaining: 712_500 });

    // Event log tells the whole story, in order
    const events = (await h.call('GET', `/v1/tasks/${t.id}/events`, { key: m.agent })).body.data.map((e: any) => e.type);
    expect(events).toEqual([
      'task.created',
      'task.status_changed', // → working
      'task.status_changed', // → needs_input
      'task.input_required',
      'task.input_received',
      'task.status_changed', // → working
      'delivery.created',
      'delivery.created',
      'delivery.rejected',
      'delivery.accepted',
      'settlement.succeeded',
      'task.status_changed', // → cancelled
    ]);

    // Every event went to the buyer's callback and the operator hook, signed
    await h.service.drain();
    const toBuyer = h.sent.filter((s) => s.url === 'https://buyer.example/hooks');
    const toOps = h.sent.filter((s) => s.url === 'https://ops.example/hook');
    expect(toBuyer).toHaveLength(events.length);
    expect(toOps).toHaveLength(events.length);
    // (signed days ago on the fake clock, so skip the replay-window check here)
    const sig = (s: (typeof h.sent)[number]) => s.headers['outcome-signature']!;
    for (const s of toBuyer) expect(verify(h.webhookSecret, sig(s), s.body, h.clock.now(), Infinity)).toBe(true);
    expect(verify('whsec_ops', sig(toOps[0]!), toOps[0]!.body, h.clock.now(), Infinity)).toBe(true);
    expect(verify('wrong', sig(toBuyer[0]!), toBuyer[0]!.body, h.clock.now(), Infinity)).toBe(false);
    expect(verify(h.webhookSecret, sig(toBuyer[0]!), toBuyer[0]!.body, h.clock.now())).toBe(false); // stale
  });

  it('flips to delivered when the last unit lands, and reopens when one is rejected', async () => {
    h = await harness(kind);
    const { task: t } = await task(h, h.owner, { quantity: 2 });
    await h.call('POST', `/v1/operator/tasks/${t.id}/deliveries`, { key: h.operator, body: meeting(h) });
    const second = await h.call('POST', `/v1/operator/tasks/${t.id}/deliveries`, { key: h.operator, body: meeting(h) });
    let cur = (await h.call('GET', `/v1/tasks/${t.id}`, { key: h.owner })).body;
    expect(cur.status).toBe('delivered');
    expect(cur.progress.remaining).toBe(0);

    const over = await h.call('POST', `/v1/operator/tasks/${t.id}/deliveries`, { key: h.operator, body: meeting(h) });
    expect(over.body.error.code).toBe('invalid_state');

    await h.call('POST', `/v1/deliveries/${second.body.id}/reject`, { key: h.owner, body: { reason_code: 'off_icp' } });
    cur = (await h.call('GET', `/v1/tasks/${t.id}`, { key: h.owner })).body;
    expect(cur).toMatchObject({ status: 'working', status_reason: 'Delivery rejected; slot reopened', progress: { remaining: 1 } });
  });

  it('expires at the deadline, bills what was accepted and releases the rest', async () => {
    h = await harness(kind);
    const m = await mandate(h);
    const { task: t } = await task(h, m.agent, { quantity: 4 });
    const d = (await h.call('POST', `/v1/operator/tasks/${t.id}/deliveries`, { key: h.operator, body: meeting(h, { inDays: 2 }) })).body;
    await h.call('POST', `/v1/deliveries/${d.id}/accept`, { key: m.agent });

    h.clock.advance(31 * DAY);
    const tick = await h.call('POST', '/cron/tick', { headers: { authorization: 'Bearer cron_secret' } });
    expect(tick.body.tasks_expired).toBe(1);
    const cur = (await h.call('GET', `/v1/tasks/${t.id}`, { key: m.agent })).body;
    expect(cur).toMatchObject({
      status: 'expired',
      status_reason: 'Deadline passed with 1 of 4 delivered',
      billing: { committed: 37_500, settled: 37_500 },
    });
    expect((await h.call('GET', `/v1/mandates/${m.id}`, { key: m.agent })).body).toMatchObject({ spent: 37_500, reserved: 0, remaining: 712_500 });
    expect((await h.call('POST', '/cron/tick')).status).toBe(401);
  });

  it('never lets concurrent commitments overspend a mandate', async () => {
    h = await harness(kind);
    const m = await mandate(h, { max_total: 5 * 37_500 });
    const q1 = await h.call('POST', '/v1/quotes', { key: m.agent, body: intent({ quantity: 3 }) });
    const q2 = await h.call('POST', '/v1/quotes', { key: m.agent, body: intent({ quantity: 3 }) });
    const results = await Promise.all([
      h.call('POST', '/v1/tasks', { key: m.agent, body: { quote_id: q1.body.id } }),
      h.call('POST', '/v1/tasks', { key: m.agent, body: { quote_id: q2.body.id } }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 402]);
    const denied = results.find((r) => r.status === 402)!;
    expect(denied.body.error).toMatchObject({ code: 'mandate_budget_exceeded', details: { remaining: 75_000, max_affordable_quantity: 2 } });
    expect((await h.call('GET', `/v1/mandates/${m.id}`, { key: m.agent })).body).toMatchObject({ reserved: 112_500, remaining: 75_000 });
  });
});
