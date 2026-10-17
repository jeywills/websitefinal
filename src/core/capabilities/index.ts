import { z } from 'zod';
import { errors } from '../errors.js';
import { IntentBase, type Intent } from '../schemas.js';
import { meetingBooked } from './meeting-booked.js';
import type { Capability } from './types.js';

export type { Capability, Assessment } from './types.js';

export class CapabilityRegistry {
  private readonly byId = new Map<string, Capability>();

  constructor(capabilities: Capability<any, any>[]) {
    for (const c of capabilities) this.byId.set(c.id, c as Capability);
  }

  list(): Capability[] {
    return [...this.byId.values()];
  }

  get(id: string): Capability {
    const c = this.byId.get(id);
    if (!c) throw errors.invalid(`Unknown outcome "${id}"`, { available: [...this.byId.keys()] });
    return c;
  }

  /** Validates the envelope, then the outcome-specific constraints. Returns the intent with defaults applied. */
  parseIntent(body: unknown): { intent: Intent; capability: Capability } {
    const base = IntentBase.safeParse(body);
    if (!base.success) throw errors.invalid('Invalid intent', z.treeifyError(base.error));
    const capability = this.get(base.data.outcome);
    const constraints = capability.constraints.safeParse(base.data.constraints);
    if (!constraints.success) {
      throw errors.invalid(`Invalid constraints for ${capability.id}`, z.treeifyError(constraints.error));
    }
    return { intent: { ...base.data, constraints: constraints.data }, capability };
  }

  /** The intent schema as a discriminated union over outcomes, for docs and tool schemas. */
  intentSchema() {
    const variants = this.list().map((c) =>
      IntentBase.extend({ outcome: z.literal(c.id), constraints: c.constraints as z.ZodType }),
    );
    return variants.length === 1 ? variants[0]! : z.discriminatedUnion('outcome', variants as [never, never]);
  }

  describe() {
    return this.list().map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      unit: c.unit,
      default_window_days: c.default_window_days,
      terms: { billing: 'per_accepted_unit', ...c.terms },
      constraints_schema: z.toJSONSchema(c.constraints, { io: 'input' }),
      result_schema: z.toJSONSchema(c.result, { io: 'input' }),
      example_intent: c.example,
    }));
  }
}

export const defaultCapabilities = () => new CapabilityRegistry([meetingBooked]);
