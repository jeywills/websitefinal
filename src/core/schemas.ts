/**
 * The contract. Every object the API accepts or returns is defined here once and
 * exported as JSON Schema (/schemas/outcome.json), OpenAPI components and MCP tool
 * input schemas. Amounts are integers in minor units (pence/cents), Stripe-style.
 */
import { z } from 'zod';

export const Currency = z.enum(['gbp', 'usd', 'eur']);
export const Timestamp = z.iso.datetime({ offset: true });
export const Amount = z.number().int().nonnegative().describe('Integer amount in minor units (pence / cents)');
export const Metadata = z.record(z.string(), z.string().max(500)).describe('Free-form string key/values, echoed back');

// ---------------------------------------------------------------- Intent

export const Budget = z
  .object({
    currency: Currency,
    max_unit_price: z.number().int().positive().describe('Most the caller will pay per accepted unit, minor units'),
    max_total: z.number().int().positive().optional().describe('Hard cap on total spend for this intent, minor units'),
  })
  .describe('What the caller is willing to spend');

export const IntentBase = z.object({
  outcome: z.string().describe('Outcome type, e.g. "meeting.booked". See GET /v1/capabilities'),
  quantity: z.number().int().min(1).max(500).describe('Units of the outcome wanted'),
  constraints: z.record(z.string(), z.unknown()).describe('Outcome-specific constraints (ICP, geo, ...)'),
  budget: Budget,
  deadline: Timestamp.optional().describe('When units must be delivered by. Defaults to the outcome\'s standard window'),
  brief: z.string().max(4000).optional().describe('Context for whoever fulfils it: offer, value prop, tone'),
  metadata: Metadata.optional(),
});
export type Intent = z.infer<typeof IntentBase>;

// ---------------------------------------------------------------- Quote

export const Confidence = z.enum(['low', 'medium', 'high']);

export const Feasibility = z.object({
  status: z.enum(['feasible', 'partial', 'infeasible']),
  requested_quantity: z.number().int(),
  likely_quantity: z.number().int().describe('Units the server expects to deliver by the deadline'),
  confidence: Confidence,
  reasons: z.array(z.string()),
});

export const Terms = z.object({
  billing: z.literal('per_accepted_unit'),
  acceptance_window_hours: z.number().int().positive(),
  acceptance_anchor: z
    .enum(['delivered_at', 'occurs_at'])
    .describe('Window starts at delivery, or at when the outcome actually happens (e.g. the meeting time)'),
  reject_reasons: z.array(z.string()),
});

export const MandateCheck = z.object({
  mandate_id: z.string(),
  ok: z.boolean(),
  violations: z.array(z.string()),
  remaining: Amount,
  max_affordable_quantity: z.number().int(),
});

export const Quote = z.object({
  id: z.string(),
  object: z.literal('quote'),
  account_id: z.string(),
  status: z.enum(['open', 'accepted', 'expired']),
  intent: IntentBase,
  feasibility: Feasibility,
  price: z.object({ currency: Currency, unit_amount: Amount, max_total: Amount }),
  eta: z.object({
    first_delivery_by: Timestamp,
    deadline: Timestamp,
    full_quantity_by: Timestamp.nullable(),
  }),
  terms: Terms,
  mandate_check: MandateCheck.nullable(),
  expires_at: Timestamp,
  created_at: Timestamp,
});
export type Quote = z.infer<typeof Quote>;

// ---------------------------------------------------------------- Evidence / checks

export const EvidenceType = z.enum([
  'calendar_invite',
  'email_thread',
  'call_recording',
  'transcript',
  'crm_record',
  'source',
  'other',
]);

export const Evidence = z.object({
  type: EvidenceType,
  uri: z.url().optional(),
  description: z.string().max(2000).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional().describe('Hash of the artefact, for tamper evidence'),
  captured_at: Timestamp.optional(),
});
export type Evidence = z.infer<typeof Evidence>;

export const Check = z.object({
  name: z.string(),
  result: z.enum(['pass', 'warn', 'fail']),
  detail: z.string(),
});
export type Check = z.infer<typeof Check>;

// ---------------------------------------------------------------- Task

export const TaskStatus = z.enum(['queued', 'working', 'needs_input', 'delivered', 'expired', 'cancelled', 'failed']);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const InputField = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(1000).optional(),
  required: z.boolean().default(true),
});

export const InputRequest = z.object({
  id: z.string(),
  question: z.string(),
  fields: z.array(InputField),
  requested_at: Timestamp,
  answered_at: Timestamp.nullable(),
  answers: z.record(z.string(), z.unknown()).nullable(),
});
export type InputRequest = z.infer<typeof InputRequest>;

export const Task = z.object({
  id: z.string(),
  object: z.literal('task'),
  account_id: z.string(),
  quote_id: z.string(),
  mandate_id: z.string().nullable(),
  outcome: z.string(),
  status: TaskStatus,
  status_reason: z.string().nullable(),
  intent: IntentBase,
  quantity: z.number().int(),
  unit_amount: Amount,
  currency: Currency,
  terms: Terms,
  deadline: Timestamp,
  progress: z.object({
    pending: z.number().int().describe('Delivered, awaiting acceptance'),
    accepted: z.number().int(),
    rejected: z.number().int(),
    remaining: z.number().int().describe('Units still to deliver'),
  }),
  billing: z.object({
    committed: Amount.describe('Most this task can still cost in total (reserved against the mandate)'),
    settled: Amount.describe('Billed for accepted units'),
  }),
  input_requests: z.array(InputRequest),
  callback_url: z.url().nullable(),
  metadata: Metadata,
  created_at: Timestamp,
  updated_at: Timestamp,
});
export type Task = z.infer<typeof Task>;

// ---------------------------------------------------------------- Delivery

export const DeliveryStatus = z.enum(['pending_acceptance', 'accepted', 'rejected']);

export const RejectReason = z.enum(['off_icp', 'no_show', 'duplicate', 'not_qualified', 'evidence_invalid', 'other']);

export const Delivery = z.object({
  id: z.string(),
  object: z.literal('delivery'),
  task_id: z.string(),
  account_id: z.string(),
  outcome: z.string(),
  summary: z.string(),
  result: z.record(z.string(), z.unknown()).describe('Outcome-specific payload'),
  evidence: z.array(Evidence),
  checks: z.array(Check).describe('Server-side conformance checks against the intent'),
  status: DeliveryStatus,
  amount: Amount,
  currency: Currency,
  occurs_at: Timestamp.nullable(),
  acceptance_window_ends_at: Timestamp,
  decision: z
    .object({
      by: z.enum(['buyer', 'system']),
      reason_code: RejectReason.nullable(),
      note: z.string().nullable(),
      at: Timestamp,
    })
    .nullable(),
  settlement_id: z.string().nullable(),
  created_at: Timestamp,
});
export type Delivery = z.infer<typeof Delivery>;

// ---------------------------------------------------------------- Settlement

export const Settlement = z.object({
  id: z.string(),
  object: z.literal('settlement'),
  account_id: z.string(),
  task_id: z.string(),
  delivery_id: z.string(),
  mandate_id: z.string().nullable(),
  amount: Amount,
  currency: Currency,
  status: z.enum(['pending', 'succeeded', 'failed']),
  provider: z.string(),
  provider_ref: z.string().nullable(),
  attempts: z.number().int(),
  last_error: z.string().nullable(),
  next_attempt_at: Timestamp.nullable(),
  created_at: Timestamp,
  updated_at: Timestamp,
});
export type Settlement = z.infer<typeof Settlement>;

// ---------------------------------------------------------------- Mandate

export const MandateScope = z.object({
  outcomes: z.array(z.string()).min(1),
  currency: Currency,
  max_total: z.number().int().positive().describe('Total the agent may commit across all tasks, minor units'),
  max_unit_price: z.number().int().positive().optional(),
  constraints: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Allowed envelope. Arrays are allow-lists (intent values must be a subset); {min,max} objects are ranges the intent must sit inside; scalars must match exactly'),
});

export const Mandate = z.object({
  id: z.string(),
  object: z.literal('mandate'),
  account_id: z.string(),
  label: z.string().nullable(),
  status: z.enum(['active', 'revoked']),
  scope: MandateScope,
  spent: Amount,
  reserved: Amount,
  remaining: Amount,
  expires_at: Timestamp,
  revoked_at: Timestamp.nullable(),
  created_at: Timestamp,
});
export type Mandate = z.infer<typeof Mandate>;

// ---------------------------------------------------------------- Events

export const EventType = z.enum([
  'task.created',
  'task.status_changed',
  'task.input_required',
  'task.input_received',
  'delivery.created',
  'delivery.accepted',
  'delivery.rejected',
  'settlement.succeeded',
  'settlement.failed',
]);
export type EventType = z.infer<typeof EventType>;

export const OutcomeEvent = z.object({
  id: z.string(),
  object: z.literal('event'),
  seq: z.number().int(),
  type: EventType,
  account_id: z.string(),
  task_id: z.string(),
  data: z.record(z.string(), z.unknown()),
  created_at: Timestamp,
});
export type OutcomeEvent = z.infer<typeof OutcomeEvent>;

// ---------------------------------------------------------------- Requests

export const QuoteCreate = IntentBase.describe('An intent: goal + constraints + max spend');

export const TaskCreate = z.object({
  quote_id: z.string(),
  mandate_id: z.string().optional().describe('Required for agent keys (defaults to the key\'s mandate)'),
  callback_url: z.url().optional().describe('Receives signed webhook POSTs for every task event'),
  metadata: Metadata.optional(),
});

export const InputResponse = z.object({
  request_id: z.string(),
  answers: z.record(z.string(), z.unknown()),
});

export const DeliveryReject = z.object({
  reason_code: RejectReason,
  note: z.string().max(2000).optional(),
});

export const MandateCreate = z.object({
  label: z.string().max(200).optional(),
  scope: MandateScope,
  expires_at: Timestamp,
  issue_agent_key: z.boolean().default(true).describe('Return a new API key that can only act inside this mandate'),
});

export const OperatorNote = z.object({ note: z.string().max(2000).optional() });

export const OperatorInputRequest = z.object({
  question: z.string().min(1).max(4000),
  fields: z.array(InputField).default([]),
});

export const OperatorDelivery = z.object({
  result: z.record(z.string(), z.unknown()),
  evidence: z.array(Evidence).min(1),
});

export const OperatorFail = z.object({ reason: z.string().min(1).max(2000) });

export const AccountCreate = z.object({
  name: z.string().min(1).max(200),
  stripe_customer_id: z.string().optional(),
});

export const AccountUpdate = z.object({
  name: z.string().min(1).max(200).optional(),
  stripe_customer_id: z.string().nullable().optional(),
});

export const OperatorKeyCreate = z.object({ label: z.string().max(200).optional() });

// ---------------------------------------------------------------- Internal docs (never returned raw)

export type Role = 'owner' | 'agent' | 'operator';

export interface Account {
  id: string;
  object: 'account';
  name: string;
  stripe_customer_id: string | null;
  webhook_secret: string;
  created_at: string;
}

export interface ApiKey {
  id: string;
  object: 'api_key';
  account_id: string | null;
  mandate_id: string | null;
  role: Role;
  key_hash: string;
  label: string | null;
  status: 'active' | 'revoked';
  created_at: string;
}

export interface WebhookDelivery {
  id: string;
  object: 'webhook';
  account_id: string;
  event_id: string;
  target: 'callback' | 'operator';
  url: string;
  payload: OutcomeEvent;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  last_error: string | null;
  next_attempt_at: string | null;
  created_at: string;
}

export interface IdempotencyRecord {
  id: string;
  object: 'idempotency';
  account_id: string;
  request_hash: string;
  status: 'in_progress' | 'done';
  response: { status: number; body: unknown } | null;
  created_at: string;
}

/** A stored mandate. `remaining` is derived on read. */
export type MandateDoc = Omit<Mandate, 'remaining'>;
