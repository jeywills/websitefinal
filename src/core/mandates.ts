import type { Intent, Mandate, MandateDoc } from './schemas.js';

type Range = { min?: number; max?: number };

const norm = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : v);

function isRange(v: unknown): v is Range {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.keys(v).length > 0 &&
    Object.keys(v).every((k) => k === 'min' || k === 'max')
  );
}

/**
 * Checks intent constraints against a mandate's allowed envelope.
 * Arrays are allow-lists, {min,max} are enclosing ranges, scalars must match.
 * A constraint the mandate restricts but the intent leaves open is a violation:
 * "no filter" is wider than any allow-list.
 */
export function scopeViolations(allowed: Record<string, unknown> | undefined, constraints: Record<string, unknown>): string[] {
  if (!allowed) return [];
  const out: string[] = [];
  for (const [key, rule] of Object.entries(allowed)) {
    const value = constraints[key];
    if (Array.isArray(rule)) {
      const ok = new Set(rule.map(norm));
      if (!Array.isArray(value) || value.length === 0) {
        out.push(`${key}: mandate allows only [${rule.join(', ')}]; intent must set it`);
        continue;
      }
      const outside = value.filter((v) => !ok.has(norm(v)));
      if (outside.length) out.push(`${key}: [${outside.join(', ')}] outside mandate scope [${rule.join(', ')}]`);
    } else if (isRange(rule)) {
      if (!isRange(value)) {
        out.push(`${key}: mandate requires a range within ${JSON.stringify(rule)}`);
        continue;
      }
      if (rule.min !== undefined && (value.min === undefined || value.min < rule.min)) {
        out.push(`${key}.min: must be >= ${rule.min}`);
      }
      if (rule.max !== undefined && (value.max === undefined || value.max > rule.max)) {
        out.push(`${key}.max: must be <= ${rule.max}`);
      }
    } else if (norm(value) !== norm(rule)) {
      out.push(`${key}: must equal ${JSON.stringify(rule)}`);
    }
  }
  return out;
}

export function remaining(m: MandateDoc): number {
  return Math.max(0, m.scope.max_total - m.spent - m.reserved);
}

export function withRemaining(m: MandateDoc): Mandate {
  return { ...m, remaining: remaining(m) };
}

export function mandateExpired(m: MandateDoc, now: Date): boolean {
  return new Date(m.expires_at).getTime() <= now.getTime();
}

/** Everything except budget: is this intent something the mandate allows at all? */
export function mandateViolations(m: MandateDoc, intent: Intent, unitAmount: number): string[] {
  const out: string[] = [];
  if (!m.scope.outcomes.includes(intent.outcome)) {
    out.push(`outcome: ${intent.outcome} not in mandate scope [${m.scope.outcomes.join(', ')}]`);
  }
  if (intent.budget.currency !== m.scope.currency) {
    out.push(`currency: mandate is ${m.scope.currency}, intent is ${intent.budget.currency}`);
  }
  if (m.scope.max_unit_price !== undefined && unitAmount > m.scope.max_unit_price) {
    out.push(`unit price ${unitAmount} exceeds mandate max_unit_price ${m.scope.max_unit_price}`);
  }
  out.push(...scopeViolations(m.scope.constraints, intent.constraints));
  return out;
}
