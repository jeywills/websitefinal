import type { z } from 'zod';
import type { Check, Delivery, Evidence, Intent } from '../schemas.js';

export interface Assessment {
  unit_amount: number;
  /** Expected deliverable units per day for this ICP. */
  daily_rate: number;
  /** Days before the first unit can land (list build, copy, ramp). */
  ramp_days: number;
  reasons: string[];
}

/**
 * One sellable outcome. Adding a capability = defining what the caller can
 * constrain, what a delivery looks like, how it is priced, and how a delivery
 * is checked against the intent before the buyer ever sees it.
 */
export interface Capability<C = Record<string, unknown>, R = Record<string, unknown>> {
  id: string;
  name: string;
  description: string;
  unit: string;
  constraints: z.ZodType<C>;
  result: z.ZodType<R>;
  default_window_days: number;
  terms: {
    acceptance_window_hours: number;
    acceptance_anchor: 'delivered_at' | 'occurs_at';
  };
  example: Intent;
  assess(intent: Intent & { constraints: C }): Assessment;
  check(input: { intent: Intent & { constraints: C }; result: R; evidence: Evidence[]; prior: Delivery[]; now: Date }): Check[];
  /** When the outcome actually happens (e.g. meeting end), if not at delivery. */
  occursAt(result: R): string | null;
  summarize(result: R): string;
}
