import { z } from 'zod';
import { Timestamp } from '../schemas.js';
import type { Capability } from './types.js';

const CountryCode = z
  .string()
  .regex(/^[A-Za-z]{2}$/)
  .transform((s) => s.toUpperCase())
  .describe('ISO 3166-1 alpha-2');

export const MeetingConstraints = z.object({
  geo: z.array(CountryCode).min(1).describe('Countries the prospect company must be in'),
  industries: z.array(z.string().min(1)).min(1).describe('e.g. ["fintech"]'),
  titles: z.array(z.string().min(1)).min(1).describe('Attendee titles, e.g. ["CFO", "COO"]'),
  company_size: z
    .object({ min: z.number().int().positive().optional(), max: z.number().int().positive().optional() })
    .optional()
    .describe('Employee count range'),
  exclude_domains: z.array(z.string()).default([]).describe('Customers, open deals, competitors'),
  one_per_company: z.boolean().default(true),
  meeting: z
    .object({
      duration_minutes: z.number().int().min(10).max(120).default(30),
      booking_link: z.url().optional(),
    })
    .optional(),
});
export type MeetingConstraints = z.infer<typeof MeetingConstraints>;

export const MeetingResult = z.object({
  attendee: z.object({
    name: z.string().min(1),
    title: z.string().min(1),
    email: z.email(),
    linkedin_url: z.url().optional(),
  }),
  company: z.object({
    name: z.string().min(1),
    domain: z.string().min(3),
    country: CountryCode,
    industry: z.string().min(1),
    employees: z.number().int().positive().optional(),
  }),
  scheduled_at: Timestamp,
  duration_minutes: z.number().int().positive().default(30),
  calendar_event_id: z.string().optional(),
  notes: z.string().max(4000).optional(),
});
export type MeetingResult = z.infer<typeof MeetingResult>;

// ---------------------------------------------------------------- Pricing model v0
// Placeholder numbers, anchored on the £375/meeting C-suite rate. Recalibrate
// from real throughput (meetings per SDR-day per ICP) before quoting anyone big.

type Tier = 'c_suite' | 'vp' | 'director' | 'manager';

const PRICE: Record<'gbp' | 'usd' | 'eur', Record<Tier, number>> = {
  gbp: { c_suite: 37_500, vp: 30_000, director: 25_000, manager: 17_500 },
  usd: { c_suite: 47_500, vp: 38_000, director: 32_000, manager: 22_500 },
  eur: { c_suite: 43_500, vp: 35_000, director: 29_000, manager: 20_500 },
};

/** Meetings per 30 days for a broad, single-industry ICP with one SDR seat. */
const BASE_PER_30_DAYS = 30;
const RAMP_DAYS = 7;

/** Relative pool size by country; summed and capped. */
const MARKET: Record<string, number> = {
  US: 1.3, GB: 0.8, DE: 0.6, FR: 0.5, CA: 0.4, NL: 0.35, AU: 0.35, ES: 0.3, IT: 0.3,
  SE: 0.25, IE: 0.25, CH: 0.25, DK: 0.2, NO: 0.2, BE: 0.2, PL: 0.2, SG: 0.2, AE: 0.2,
};

const SENIORITY_FACTOR: Record<Tier, number> = { c_suite: 0.85, vp: 0.95, director: 1, manager: 1.1 };
const TIER_ORDER: Tier[] = ['manager', 'director', 'vp', 'c_suite'];

export function tierOf(title: string): Tier {
  const t = title.toLowerCase();
  if (/\bc[a-z]{1,2}o\b/.test(t) || /chief|founder|president|owner|managing director|partner/.test(t)) return 'c_suite';
  if (/\b(s|e)?vp\b|vice president|head of/.test(t)) return 'vp';
  if (/director/.test(t)) return 'director';
  return 'manager';
}

function topTier(titles: string[]): Tier {
  return titles.map(tierOf).reduce((a, b) => (TIER_ORDER.indexOf(b) > TIER_ORDER.indexOf(a) ? b : a), 'manager');
}

const step = (n: number, values: number[]) => values[Math.min(n, values.length) - 1] ?? 1;

// ---------------------------------------------------------------- Matching helpers

const TITLE_ALIASES: Record<string, string[]> = {
  ceo: ['chief executive officer', 'chief executive'],
  cfo: ['chief financial officer', 'finance director', 'fd'],
  coo: ['chief operating officer', 'operations director'],
  cto: ['chief technology officer', 'chief technical officer'],
  cro: ['chief revenue officer'],
  cmo: ['chief marketing officer'],
  cio: ['chief information officer'],
  ciso: ['chief information security officer'],
  cpo: ['chief product officer'],
};

const words = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
export const normalizeDomain = (d: string) =>
  d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');

export function titleMatches(actual: string, wanted: string[]): boolean {
  const a = words(actual);
  return wanted.some((w) => {
    const key = w.trim().toLowerCase();
    return [key, ...(TITLE_ALIASES[key] ?? [])].some((c) => a.includes(words(c)));
  });
}

// ---------------------------------------------------------------- Capability

export const meetingBooked: Capability<MeetingConstraints, MeetingResult> = {
  id: 'meeting.booked',
  name: 'Qualified meeting booked',
  description:
    'A first meeting between your team and a prospect matching your ICP, on your calendar. ' +
    'Billed per meeting accepted; auto-accepted 72h after the meeting time unless rejected (e.g. no-show, off-ICP).',
  unit: 'meeting',
  constraints: MeetingConstraints,
  result: MeetingResult,
  default_window_days: 30,
  terms: { acceptance_window_hours: 72, acceptance_anchor: 'occurs_at' },
  example: {
    outcome: 'meeting.booked',
    quantity: 20,
    constraints: { geo: ['GB'], industries: ['fintech'], titles: ['CFO', 'COO'] },
    budget: { currency: 'gbp', max_unit_price: 37_500 },
    brief: 'Embedded lending infrastructure for UK fintechs. Pitch: launch credit products in weeks, not quarters.',
  },

  assess(intent) {
    const c = intent.constraints;
    const tier = topTier(c.titles);
    const geo = Math.min(1.5, c.geo.reduce((sum, g) => sum + (MARKET[g] ?? 0.15), 0));
    const industry = step(c.industries.length, [0.85, 0.95, 1]);
    const titles = step(c.titles.length, [0.6, 0.8, 1]);
    const { min, max } = c.company_size ?? {};
    const size = min && max && max / min < 5 ? 0.85 : 1;
    const factor = geo * industry * titles * SENIORITY_FACTOR[tier] * size;

    const reasons: string[] = [];
    if (geo < 1) reasons.push(`Addressable pool limited by geography (${c.geo.join(', ')})`);
    if (c.industries.length === 1) reasons.push(`Single industry (${c.industries[0]})`);
    if (c.titles.length < 3) reasons.push(`${c.titles.length} target title(s): ${c.titles.join(', ')}`);
    if (tier === 'c_suite') reasons.push('C-suite attendees book slower and price at the top tier');
    if (size < 1) reasons.push('Narrow company size band');

    return {
      unit_amount: PRICE[intent.budget.currency][tier],
      daily_rate: (BASE_PER_30_DAYS / 30) * factor,
      ramp_days: RAMP_DAYS,
      reasons,
    };
  },

  check({ intent, result, evidence, prior, now }) {
    const c = intent.constraints;
    const domain = normalizeDomain(result.company.domain);
    const live = prior.filter((d) => d.status !== 'rejected');
    const priorResults = live.map((d) => d.result as MeetingResult);
    const scheduled = new Date(result.scheduled_at).getTime();
    const day = 86_400_000;
    const checks = [] as ReturnType<Capability['check']>;
    const add = (name: string, result: 'pass' | 'warn' | 'fail', detail: string) => checks.push({ name, result, detail });

    const invite = evidence.some((e) => e.type === 'calendar_invite');
    add('evidence.calendar_invite', invite ? 'pass' : 'fail', invite ? 'Calendar invite attached' : 'A calendar_invite evidence item is required');

    add(
      'icp.geo',
      c.geo.includes(result.company.country) ? 'pass' : 'fail',
      `${result.company.country} vs [${c.geo.join(', ')}]`,
    );

    const industryOk = c.industries.map(slug).includes(slug(result.company.industry));
    add('icp.industry', industryOk ? 'pass' : 'fail', `${result.company.industry} vs [${c.industries.join(', ')}]`);

    add(
      'icp.title',
      titleMatches(result.attendee.title, c.titles) ? 'pass' : 'warn',
      `"${result.attendee.title}" vs [${c.titles.join(', ')}]`,
    );

    if (c.company_size) {
      const { min, max } = c.company_size;
      const n = result.company.employees;
      if (n === undefined) add('icp.company_size', 'warn', 'Employee count not supplied');
      else add('icp.company_size', (min === undefined || n >= min) && (max === undefined || n <= max) ? 'pass' : 'fail', `${n} employees vs ${min ?? 0}–${max ?? '∞'}`);
    }

    const excluded = c.exclude_domains.map(normalizeDomain).includes(domain);
    add('exclusions', excluded ? 'fail' : 'pass', excluded ? `${domain} is on the exclusion list` : 'Not excluded');

    const email = result.attendee.email.toLowerCase();
    const dupPerson = priorResults.some((r) => r.attendee.email.toLowerCase() === email);
    const dupCompany = c.one_per_company && priorResults.some((r) => normalizeDomain(r.company.domain) === domain);
    add(
      'dedupe',
      dupPerson || dupCompany ? 'fail' : 'pass',
      dupPerson ? `${email} already delivered on this task` : dupCompany ? `${domain} already delivered (one_per_company)` : 'First meeting with this company',
    );

    if (scheduled < now.getTime() - 7 * day) add('timing', 'fail', 'Meeting is more than 7 days in the past');
    else if (scheduled > now.getTime() + 45 * day) add('timing', 'warn', 'Meeting is more than 45 days out; no-show risk rises');
    else add('timing', 'pass', 'Meeting date within window');

    return checks;
  },

  occursAt(result) {
    return new Date(new Date(result.scheduled_at).getTime() + result.duration_minutes * 60_000).toISOString();
  },

  summarize(result) {
    return `${result.attendee.name}, ${result.attendee.title} @ ${result.company.name} — ${result.scheduled_at}`;
  },
};
