import { describe, expect, it } from 'vitest';
import { normalizeDomain, tierOf, titleMatches } from '../src/core/capabilities/meeting-booked.js';
import { scopeViolations } from '../src/core/mandates.js';
import { fmt } from '../src/core/money.js';
import { harness, intent } from './helpers.js';

describe('meeting.booked pricing model', () => {
  it('quotes the spec example: 20 UK fintech CFO/COO meetings → likely 14 in 30 days at £375', async () => {
    const h = await harness();
    const q = await h.call('POST', '/v1/quotes', { key: h.owner, body: intent() });
    expect(q.status).toBe(201);
    expect(q.body.feasibility).toMatchObject({ status: 'partial', requested_quantity: 20, likely_quantity: 14, confidence: 'medium' });
    expect(q.body.feasibility.reasons[0]).toBe('Likely 14 of 20 by the deadline');
    expect(q.body.price).toEqual({ currency: 'gbp', unit_amount: 37_500, max_total: 750_000 });
    expect(q.body.terms).toMatchObject({ billing: 'per_accepted_unit', acceptance_window_hours: 72, acceptance_anchor: 'occurs_at' });
    expect(q.body.eta.deadline).toBe('2026-11-18T09:00:00.000Z');
    expect(q.body.eta.full_quantity_by > q.body.eta.deadline).toBe(true);
    expect(q.body.mandate_check).toBeNull();
  });

  it('is feasible with high confidence for a broad ICP', async () => {
    const h = await harness();
    const q = await h.call('POST', '/v1/quotes', {
      key: h.owner,
      body: intent({
        quantity: 10,
        constraints: { geo: ['US', 'GB', 'DE'], industries: ['fintech', 'saas', 'insurtech'], titles: ['Head of Finance', 'VP Finance', 'Finance Director'] },
      }),
    });
    expect(q.body.feasibility).toMatchObject({ status: 'feasible', likely_quantity: 10, confidence: 'high' });
    expect(q.body.price.unit_amount).toBe(30_000); // VP tier
  });

  it('is infeasible when the unit price is above budget, and says so', async () => {
    const h = await harness();
    const q = await h.call('POST', '/v1/quotes', { key: h.owner, body: intent({ budget: { currency: 'gbp', max_unit_price: 30_000 } }) });
    expect(q.body.feasibility.status).toBe('infeasible');
    expect(q.body.feasibility.reasons[0]).toBe('Unit price £375 is above max_unit_price £300');
  });

  it('is infeasible when quantity × price breaks max_total', async () => {
    const h = await harness();
    const q = await h.call('POST', '/v1/quotes', { key: h.owner, body: intent({ budget: { currency: 'gbp', max_unit_price: 37_500, max_total: 200_000 } }) });
    expect(q.body.feasibility.status).toBe('infeasible');
    expect(q.body.feasibility.reasons[0]).toContain('it covers 5');
  });

  it('is infeasible inside the ramp', async () => {
    const h = await harness();
    const deadline = new Date(h.clock.now().getTime() + 3 * 86_400_000).toISOString();
    const q = await h.call('POST', '/v1/quotes', { key: h.owner, body: intent({ deadline }) });
    expect(q.body.feasibility).toMatchObject({ status: 'infeasible', likely_quantity: 0 });
  });

  it('rejects malformed intents with field-level detail', async () => {
    const h = await harness();
    const bad = await h.call('POST', '/v1/quotes', { key: h.owner, body: intent({ constraints: { geo: ['GBR'], titles: [] } }) });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_request');
    const unknown = await h.call('POST', '/v1/quotes', { key: h.owner, body: intent({ outcome: 'unicorn.delivered' }) });
    expect(unknown.body.error.details.available).toEqual(['meeting.booked']);
  });
});

describe('helpers', () => {
  it('classifies seniority', () => {
    expect(tierOf('CFO')).toBe('c_suite');
    expect(tierOf('Chief Operating Officer')).toBe('c_suite');
    expect(tierOf('CISO')).toBe('c_suite');
    expect(tierOf('VP Sales')).toBe('vp');
    expect(tierOf('Head of RevOps')).toBe('vp');
    expect(tierOf('Finance Director')).toBe('director');
    expect(tierOf('Account Manager')).toBe('manager');
  });

  it('matches titles with aliases on word boundaries', () => {
    expect(titleMatches('Group CFO', ['CFO'])).toBe(true);
    expect(titleMatches('Chief Financial Officer', ['cfo'])).toBe(true);
    expect(titleMatches('FD', ['CFO'])).toBe(true);
    expect(titleMatches('VP Finance', ['CFO', 'COO'])).toBe(false);
    expect(titleMatches('Coordinator', ['COO'])).toBe(false);
  });

  it('normalises domains', () => {
    expect(normalizeDomain('https://www.Acme.co.uk/about')).toBe('acme.co.uk');
  });

  it('checks mandate scope envelopes', () => {
    const allowed = { geo: ['GB', 'IE'], company_size: { min: 50, max: 1000 }, one_per_company: true };
    expect(scopeViolations(allowed, { geo: ['gb'], company_size: { min: 100, max: 500 }, one_per_company: true })).toEqual([]);
    expect(scopeViolations(allowed, { geo: ['GB', 'US'], company_size: { min: 10 }, one_per_company: false })).toEqual([
      'geo: [US] outside mandate scope [GB, IE]',
      'company_size.min: must be >= 50',
      'company_size.max: must be <= 1000',
      'one_per_company: must equal true',
    ]);
    expect(scopeViolations({ industries: ['fintech'] }, {})).toEqual(['industries: mandate allows only [fintech]; intent must set it']);
  });

  it('formats money', () => {
    expect(fmt(37_500, 'gbp')).toBe('£375');
    expect(fmt(750_000, 'gbp')).toBe('£7,500');
    expect(fmt(1_234_567, 'usd')).toBe('$12,345.67');
  });
});
