import type { PaymentProvider } from '../payments/types.js';
import type { Store, Tx } from '../store/types.js';
import { backoffMs, send } from '../webhooks.js';
import type { CapabilityRegistry } from './capabilities/index.js';
import { ApiError, errors } from './errors.js';
import { newApiKey, newId, newWebhookSecret, sha256 } from './ids.js';
import { mandateExpired, mandateViolations, remaining, withRemaining } from './mandates.js';
import { fmt } from './money.js';
import {
  type Account,
  AccountCreate,
  AccountUpdate,
  type ApiKey,
  type Delivery,
  DeliveryReject,
  type EventType,
  type IdempotencyRecord,
  InputResponse,
  type Intent,
  type Mandate,
  MandateCreate,
  type MandateDoc,
  OperatorDelivery,
  OperatorFail,
  OperatorInputRequest,
  OperatorKeyCreate,
  OperatorNote,
  type OutcomeEvent,
  type Quote,
  type Role,
  type Settlement,
  type Task,
  TaskCreate,
  type TaskStatus,
  type WebhookDelivery,
} from './schemas.js';
import { assertTransition, isOpen, isTerminal } from './state.js';
import { parse } from './validate.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SETTLEMENT_BACKOFF = [60_000, 10 * 60_000, HOUR, 6 * HOUR, DAY];

export interface Principal {
  role: Role;
  key_id: string;
  account_id: string | null;
  mandate_id: string | null;
}

export interface ServiceConfig {
  operatorWebhookUrl?: string;
  operatorWebhookSecret?: string;
  quoteTtlHours: number;
  allowInsecureCallbacks: boolean;
}

export interface ServiceDeps {
  store: Store;
  payments: PaymentProvider;
  capabilities: CapabilityRegistry;
  config: ServiceConfig;
  clock?: () => Date;
  fetch?: typeof fetch;
  /** Keeps the runtime alive for background work (Vercel waitUntil). */
  defer?: (p: Promise<unknown>) => void;
}

interface Ctx {
  tx: Tx;
  now: Date;
  emit(task: Task, type: EventType, data: Record<string, unknown>): Promise<void>;
  /** Runs after commit. */
  after(job: () => Promise<unknown>): void;
}

export type TaskWithDeliveries = Task & { deliveries: Delivery[] };

const iso = (d: Date) => d.toISOString();
const later = (now: Date, ms: number) => new Date(now.getTime() + ms);

export class OutcomeService {
  readonly capabilities: CapabilityRegistry;
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(private readonly d: ServiceDeps) {
    this.capabilities = d.capabilities;
  }

  now(): Date {
    return this.d.clock?.() ?? new Date();
  }

  /** Resolves once background webhooks and charges have finished. */
  async drain(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  // ================================================================ plumbing

  private background(job: Promise<unknown>) {
    const tracked: Promise<unknown> = job
      .catch((e) => console.error('[outcome] background job failed', e))
      .finally(() => this.inflight.delete(tracked));
    this.inflight.add(tracked);
    this.d.defer?.(tracked);
  }

  private async txn<T>(fn: (ctx: Ctx) => Promise<T>): Promise<T> {
    let jobs: Array<() => Promise<unknown>> = [];
    const result = await this.d.store.tx(async (tx) => {
      jobs = [];
      const now = this.now();
      return fn({
        tx,
        now,
        emit: async (task, type, data) => {
          const event = await tx.appendEvent({
            id: newId('evt'),
            object: 'event',
            type,
            account_id: task.account_id,
            task_id: task.id,
            data,
            created_at: iso(now),
          });
          for (const [target, url] of this.webhookTargets(task)) {
            const w: WebhookDelivery = {
              id: newId('whk'),
              object: 'webhook',
              account_id: task.account_id,
              event_id: event.id,
              target,
              url,
              payload: event,
              status: 'pending',
              attempts: 0,
              last_error: null,
              // Sent right after commit; the scheduler picks it up if that attempt never lands.
              next_attempt_at: iso(later(now, 60_000)),
              created_at: iso(now),
            };
            await tx.insert('webhooks', w);
            jobs.push(() => this.deliverWebhook(w.id));
          }
        },
        after: (job) => jobs.push(job),
      });
    });
    for (const job of jobs) this.background(job());
    return result;
  }

  private webhookTargets(task: Task): Array<['callback' | 'operator', string]> {
    const out: Array<['callback' | 'operator', string]> = [];
    if (task.callback_url) out.push(['callback', task.callback_url]);
    if (this.d.config.operatorWebhookUrl) out.push(['operator', this.d.config.operatorWebhookUrl]);
    return out;
  }

  private requireBuyer(p: Principal): string {
    if (p.role === 'operator' || !p.account_id) throw errors.forbidden('This endpoint is for buyer keys (owner or agent)');
    return p.account_id;
  }

  private requireOwner(p: Principal): string {
    if (p.role !== 'owner' || !p.account_id) throw errors.forbidden('Only the account owner key can do this');
    return p.account_id;
  }

  private requireOperator(p: Principal) {
    if (p.role !== 'operator') throw errors.forbidden('Operator key required');
  }

  private assertTaskAccess(p: Principal, task: Task | null): asserts task is Task {
    if (!task) throw errors.notFound('Task');
    if (p.role === 'operator') return;
    if (task.account_id !== p.account_id) throw errors.notFound('Task');
    if (p.role === 'agent' && task.mandate_id !== p.mandate_id) throw errors.notFound('Task');
  }

  private async loadTask(ctx: Ctx, id: string, p?: Principal) {
    const task = await ctx.tx.get('tasks', id, { forUpdate: true });
    if (p) this.assertTaskAccess(p, task);
    if (!task) throw errors.notFound('Task');
    return { task, before: { ...task.billing } };
  }

  private async transition(ctx: Ctx, task: Task, to: TaskStatus, reason?: string) {
    if (task.status === to) return;
    assertTransition(task.status, to);
    const from = task.status;
    task.status = to;
    task.status_reason = reason ?? null;
    task.updated_at = iso(ctx.now);
    this.recount(task);
    await ctx.emit(task, 'task.status_changed', { from, to, reason: reason ?? null, progress: task.progress });
  }

  private recount(task: Task) {
    task.progress.remaining = isOpen(task.status) || task.status === 'delivered'
      ? Math.max(0, task.quantity - task.progress.pending - task.progress.accepted)
      : 0;
  }

  /**
   * Persists the task and moves any change in its commitment onto the mandate.
   * Invariant: mandate.reserved = Σ(task.committed − task.settled), mandate.spent = Σ task.settled.
   */
  private async saveTask(ctx: Ctx, task: Task, before: Task['billing']) {
    this.recount(task);
    if (isTerminal(task.status)) task.billing.committed = task.billing.settled + task.progress.pending * task.unit_amount;
    task.updated_at = iso(ctx.now);
    await ctx.tx.update('tasks', task);

    const reservedDelta = task.billing.committed - task.billing.settled - (before.committed - before.settled);
    const spentDelta = task.billing.settled - before.settled;
    if (task.mandate_id && (reservedDelta || spentDelta)) {
      const m = await ctx.tx.get('mandates', task.mandate_id, { forUpdate: true });
      if (m) {
        m.reserved += reservedDelta;
        m.spent += spentDelta;
        await ctx.tx.update('mandates', m);
      }
    }
  }

  // ================================================================ auth

  async authenticate(rawKey: string): Promise<Principal | null> {
    const hash = sha256(rawKey);
    const key = await this.d.store.tx(async (tx) => (await tx.find('api_keys', { lookup: hash }, { limit: 1 }))[0]);
    if (!key || key.status !== 'active') return null;
    return { role: key.role, key_id: key.id, account_id: key.account_id, mandate_id: key.mandate_id };
  }

  /** Replays the stored response for a repeated Idempotency-Key; rejects reuse with a different body. */
  async idempotent<T extends { status: number; body: unknown }>(
    p: Principal,
    key: string,
    scope: string,
    request: unknown,
    run: () => Promise<T>,
  ): Promise<T | { status: number; body: unknown; replayed: true }> {
    const id = sha256(`${p.key_id}|${scope}|${key}`);
    const requestHash = sha256(JSON.stringify(request ?? null));
    const record: IdempotencyRecord = {
      id,
      object: 'idempotency',
      account_id: p.account_id ?? 'operator',
      request_hash: requestHash,
      status: 'in_progress',
      response: null,
      created_at: iso(this.now()),
    };
    const existing = await this.d.store.tx(async (tx) => ((await tx.insert('idempotency_keys', record)) ? null : tx.get('idempotency_keys', id)));
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw errors.unprocessable('idempotency_mismatch', 'Idempotency-Key was already used with a different request body');
      }
      if (existing.status === 'in_progress' || !existing.response) {
        throw errors.conflict('idempotency_in_progress', 'A request with this Idempotency-Key is still running');
      }
      return { ...existing.response, replayed: true };
    }
    try {
      const res = await run();
      await this.d.store.tx((tx) => tx.update('idempotency_keys', { ...record, status: 'done', response: { status: res.status, body: res.body } }));
      return res;
    } catch (e) {
      if (e instanceof ApiError && e.status < 500) {
        const response = { status: e.status, body: e.toJSON() };
        await this.d.store.tx((tx) => tx.update('idempotency_keys', { ...record, status: 'done', response }));
      } else {
        await this.d.store.tx((tx) => tx.remove('idempotency_keys', id));
      }
      throw e;
    }
  }

  // ================================================================ quotes

  async createQuote(p: Principal, body: unknown): Promise<Quote> {
    const accountId = this.requireBuyer(p);
    const { intent, capability } = this.capabilities.parseIntent(body);
    const now = this.now();
    const deadline = intent.deadline ? new Date(intent.deadline) : later(now, capability.default_window_days * DAY);
    if (deadline <= now) throw errors.invalid('deadline must be in the future');

    const a = capability.assess(intent);
    const days = (deadline.getTime() - now.getTime()) / DAY;
    const capacity = days < a.ramp_days ? 0 : a.daily_rate * days;
    const likely = Math.min(intent.quantity, Math.round(capacity));
    const unit = a.unit_amount;
    const cur = intent.budget.currency;
    const total = unit * intent.quantity;

    const reasons = [...a.reasons];
    let status: Quote['feasibility']['status'] = likely >= intent.quantity ? 'feasible' : likely > 0 ? 'partial' : 'infeasible';
    if (days < a.ramp_days) reasons.unshift(`Deadline falls inside the ${a.ramp_days}-day ramp`);
    if (status === 'partial') reasons.unshift(`Likely ${likely} of ${intent.quantity} by the deadline`);
    if (unit > intent.budget.max_unit_price) {
      status = 'infeasible';
      reasons.unshift(`Unit price ${fmt(unit, cur)} is above max_unit_price ${fmt(intent.budget.max_unit_price, cur)}`);
    }
    if (intent.budget.max_total !== undefined && total > intent.budget.max_total) {
      status = 'infeasible';
      reasons.unshift(
        `${intent.quantity} × ${fmt(unit, cur)} = ${fmt(total, cur)} exceeds max_total ${fmt(intent.budget.max_total, cur)}; ` +
          `it covers ${Math.floor(intent.budget.max_total / unit)}`,
      );
    }
    const ratio = capacity / intent.quantity;
    const confidence = status === 'infeasible' ? 'low' : ratio >= 1.25 ? 'high' : ratio >= 0.6 ? 'medium' : 'low';
    const fullDays = a.daily_rate > 0 ? Math.max(a.ramp_days, Math.ceil(intent.quantity / a.daily_rate)) : null;

    let mandateCheck: Quote['mandate_check'] = null;
    if (p.role === 'agent' && p.mandate_id) {
      const m = await this.d.store.tx((tx) => tx.get('mandates', p.mandate_id!));
      if (m) mandateCheck = this.checkMandate(m, intent, unit, intent.quantity, now);
    }

    const quote: Quote = {
      id: newId('qte'),
      object: 'quote',
      account_id: accountId,
      status: 'open',
      intent,
      feasibility: { status, requested_quantity: intent.quantity, likely_quantity: likely, confidence, reasons },
      price: { currency: cur, unit_amount: unit, max_total: total },
      eta: {
        first_delivery_by: iso(later(now, a.ramp_days * DAY)),
        deadline: iso(deadline),
        full_quantity_by: fullDays === null ? null : iso(later(now, fullDays * DAY)),
      },
      terms: {
        billing: 'per_accepted_unit',
        acceptance_window_hours: capability.terms.acceptance_window_hours,
        acceptance_anchor: capability.terms.acceptance_anchor,
        reject_reasons: DeliveryReject.shape.reason_code.options,
      },
      mandate_check: mandateCheck,
      expires_at: iso(later(now, this.d.config.quoteTtlHours * HOUR)),
      created_at: iso(now),
    };
    await this.d.store.tx((tx) => tx.insert('quotes', quote));
    return quote;
  }

  private checkMandate(m: MandateDoc, intent: Intent, unit: number, quantity: number, now: Date) {
    const violations = mandateViolations(m, intent, unit);
    if (m.status !== 'active') violations.unshift('mandate is revoked');
    if (mandateExpired(m, now)) violations.unshift('mandate has expired');
    const rem = remaining(m);
    const affordable = unit > 0 ? Math.floor(rem / unit) : 0;
    if (unit * quantity > rem) {
      violations.push(`commitment ${fmt(unit * quantity, m.scope.currency)} exceeds remaining ${fmt(rem, m.scope.currency)} (max ${affordable} units)`);
    }
    return { mandate_id: m.id, ok: violations.length === 0, violations, remaining: rem, max_affordable_quantity: affordable };
  }

  async getQuote(p: Principal, id: string): Promise<Quote> {
    const accountId = this.requireBuyer(p);
    const q = await this.d.store.tx((tx) => tx.get('quotes', id));
    if (!q || q.account_id !== accountId) throw errors.notFound('Quote');
    if (q.status === 'open' && new Date(q.expires_at) <= this.now()) q.status = 'expired';
    return q;
  }

  // ================================================================ tasks

  async createTask(p: Principal, body: unknown): Promise<Task> {
    const accountId = this.requireBuyer(p);
    const input = parse(TaskCreate, body);
    if (input.callback_url) this.assertCallbackUrl(input.callback_url);
    if (p.role === 'agent' && input.mandate_id && input.mandate_id !== p.mandate_id) {
      throw errors.forbidden('Agent keys can only spend from their own mandate');
    }
    const mandateId = p.role === 'agent' ? p.mandate_id : (input.mandate_id ?? null);

    return this.txn(async (ctx) => {
      const { tx, now } = ctx;
      const quote = await tx.get('quotes', input.quote_id, { forUpdate: true });
      if (!quote || quote.account_id !== accountId) throw errors.notFound('Quote');
      if (quote.status === 'accepted') throw errors.conflict('quote_already_accepted', 'This quote already has a task');
      if (quote.status === 'expired' || new Date(quote.expires_at) <= now) {
        throw errors.conflict('quote_expired', 'Quote has expired; request a new one');
      }
      if (quote.feasibility.status === 'infeasible') {
        throw errors.conflict('quote_infeasible', 'Quote is infeasible', { reasons: quote.feasibility.reasons });
      }
      const unit = quote.price.unit_amount;
      const committed = unit * quote.intent.quantity;

      if (mandateId) {
        const m = await tx.get('mandates', mandateId, { forUpdate: true });
        if (!m || m.account_id !== accountId) throw errors.notFound('Mandate');
        if (m.status !== 'active') throw errors.mandateInactive('Mandate has been revoked');
        if (mandateExpired(m, now)) throw errors.mandateInactive('Mandate has expired');
        const violations = mandateViolations(m, quote.intent, unit);
        if (violations.length) throw errors.mandateScope('Intent is outside the mandate', { violations });
        const rem = remaining(m);
        if (committed > rem) {
          throw errors.mandateBudget(
            `Committing ${fmt(committed, m.scope.currency)} would exceed the mandate's remaining ${fmt(rem, m.scope.currency)}`,
            { remaining: rem, requested: committed, unit_amount: unit, max_affordable_quantity: Math.floor(rem / unit) },
          );
        }
        m.reserved += committed;
        await tx.update('mandates', m);
      }

      quote.status = 'accepted';
      await tx.update('quotes', quote);

      const task: Task = {
        id: newId('tsk'),
        object: 'task',
        account_id: accountId,
        quote_id: quote.id,
        mandate_id: mandateId,
        outcome: quote.intent.outcome,
        status: 'queued',
        status_reason: null,
        intent: quote.intent,
        quantity: quote.intent.quantity,
        unit_amount: unit,
        currency: quote.price.currency,
        terms: quote.terms,
        deadline: quote.eta.deadline,
        progress: { pending: 0, accepted: 0, rejected: 0, remaining: quote.intent.quantity },
        billing: { committed, settled: 0 },
        input_requests: [],
        callback_url: input.callback_url ?? null,
        metadata: input.metadata ?? quote.intent.metadata ?? {},
        created_at: iso(now),
        updated_at: iso(now),
      };
      await tx.insert('tasks', task);
      await ctx.emit(task, 'task.created', { task });
      return task;
    });
  }

  private assertCallbackUrl(url: string) {
    if (new URL(url).protocol !== 'https:' && !this.d.config.allowInsecureCallbacks) {
      throw errors.invalid('callback_url must use https');
    }
  }

  async getTask(p: Principal, id: string): Promise<TaskWithDeliveries> {
    await this.reconcileTask(id);
    return this.d.store.tx(async (tx) => {
      const task = await tx.get('tasks', id);
      this.assertTaskAccess(p, task);
      return { ...task, deliveries: await tx.find('deliveries', { parent_id: id }, { limit: 1000 }) };
    });
  }

  async listTasks(p: Principal, opts: { status?: string; limit?: number } = {}): Promise<Task[]> {
    const where =
      p.role === 'operator'
        ? {}
        : p.role === 'agent'
          ? { account_id: this.requireBuyer(p), parent_id: p.mandate_id! }
          : { account_id: this.requireBuyer(p) };
    return this.d.store.tx((tx) =>
      tx.find('tasks', { ...where, ...(opts.status ? { status: opts.status.split(',') } : {}) }, { order: 'desc', limit: opts.limit ?? 50 }),
    );
  }

  async cancelTask(p: Principal, id: string, body: unknown): Promise<Task> {
    this.requireBuyer(p);
    const input = parse(OperatorNote, body ?? {});
    return this.txn(async (ctx) => {
      const { task, before } = await this.loadTask(ctx, id, p);
      await this.transition(ctx, task, 'cancelled', input.note ?? 'Cancelled by buyer');
      await this.saveTask(ctx, task, before);
      return task;
    });
  }

  async respondInput(p: Principal, id: string, body: unknown): Promise<Task> {
    this.requireBuyer(p);
    const input = parse(InputResponse, body);
    return this.txn(async (ctx) => {
      const { task, before } = await this.loadTask(ctx, id, p);
      const req = task.input_requests.find((r) => r.id === input.request_id);
      if (!req) throw errors.notFound('Input request');
      if (req.answered_at) throw errors.invalidState('Input request already answered');
      const missing = req.fields.filter((f) => f.required && input.answers[f.name] === undefined).map((f) => f.name);
      if (missing.length) throw errors.invalid('Missing required answers', { missing });
      req.answers = input.answers;
      req.answered_at = iso(ctx.now);
      await ctx.emit(task, 'task.input_received', { input_request: req });
      if (task.status === 'needs_input' && task.input_requests.every((r) => r.answered_at)) {
        await this.transition(ctx, task, 'working', 'Input received');
      }
      await this.saveTask(ctx, task, before);
      return task;
    });
  }

  async listEvents(p: Principal, taskId: string, after = 0, limit = 100): Promise<OutcomeEvent[]> {
    return this.d.store.tx(async (tx) => {
      this.assertTaskAccess(p, await tx.get('tasks', taskId));
      return tx.events({ task_id: taskId }, after, Math.min(limit, 500));
    });
  }

  // ================================================================ deliveries

  async listDeliveries(p: Principal, taskId: string): Promise<Delivery[]> {
    return (await this.getTask(p, taskId)).deliveries;
  }

  async getDelivery(p: Principal, id: string): Promise<Delivery> {
    const d = await this.d.store.tx((tx) => tx.get('deliveries', id));
    if (!d) throw errors.notFound('Delivery');
    const task = await this.getTask(p, d.task_id);
    return task.deliveries.find((x) => x.id === id)!;
  }

  async acceptDelivery(p: Principal, id: string): Promise<Delivery> {
    this.requireBuyer(p);
    return this.decide(p, id, async (ctx, task, d) => {
      await this.settle(ctx, task, d, { by: 'buyer', reason_code: null, note: null });
    });
  }

  async rejectDelivery(p: Principal, id: string, body: unknown): Promise<Delivery> {
    this.requireBuyer(p);
    const input = parse(DeliveryReject, body);
    return this.decide(p, id, async (ctx, task, d) => {
      d.status = 'rejected';
      d.decision = { by: 'buyer', reason_code: input.reason_code, note: input.note ?? null, at: iso(ctx.now) };
      await ctx.tx.update('deliveries', d);
      task.progress.pending -= 1;
      task.progress.rejected += 1;
      await ctx.emit(task, 'delivery.rejected', { delivery: d });
      if (task.status === 'delivered') {
        if (new Date(task.deadline) > ctx.now) await this.transition(ctx, task, 'working', 'Delivery rejected; slot reopened');
        else await this.transition(ctx, task, 'expired', 'Delivery rejected after the deadline');
      }
    });
  }

  private async decide(
    p: Principal | null,
    id: string,
    apply: (ctx: Ctx, task: Task, d: Delivery) => Promise<void>,
  ): Promise<Delivery> {
    const found = await this.d.store.tx((tx) => tx.get('deliveries', id));
    if (!found) throw errors.notFound('Delivery');
    return this.txn(async (ctx) => {
      const { task, before } = await this.loadTask(ctx, found.task_id, p ?? undefined);
      const d = (await ctx.tx.get('deliveries', id, { forUpdate: true }))!;
      if (d.status !== 'pending_acceptance') throw errors.invalidState(`Delivery is already ${d.status}`);
      await apply(ctx, task, d);
      await this.saveTask(ctx, task, before);
      return d;
    });
  }

  private async settle(ctx: Ctx, task: Task, d: Delivery, decision: Omit<NonNullable<Delivery['decision']>, 'at'>) {
    const s: Settlement = {
      id: newId('stl'),
      object: 'settlement',
      account_id: task.account_id,
      task_id: task.id,
      delivery_id: d.id,
      mandate_id: task.mandate_id,
      amount: d.amount,
      currency: d.currency,
      status: 'pending',
      provider: this.d.payments.name,
      provider_ref: null,
      attempts: 0,
      last_error: null,
      next_attempt_at: iso(later(ctx.now, 2 * 60_000)),
      created_at: iso(ctx.now),
      updated_at: iso(ctx.now),
    };
    d.status = 'accepted';
    d.decision = { ...decision, at: iso(ctx.now) };
    d.settlement_id = s.id;
    await ctx.tx.insert('settlements', s);
    await ctx.tx.update('deliveries', d);
    task.progress.pending -= 1;
    task.progress.accepted += 1;
    task.billing.settled += d.amount;
    await ctx.emit(task, 'delivery.accepted', { delivery: d });
    ctx.after(() => this.charge(s.id));
  }

  async listSettlements(p: Principal, opts: { task_id?: string; limit?: number } = {}): Promise<Settlement[]> {
    const accountId = this.requireBuyer(p);
    const rows = await this.d.store.tx((tx) =>
      tx.find('settlements', { account_id: accountId, ...(opts.task_id ? { parent_id: opts.task_id } : {}) }, { order: 'desc', limit: opts.limit ?? 100 }),
    );
    return p.role === 'agent' ? rows.filter((s) => s.mandate_id === p.mandate_id) : rows;
  }

  // ================================================================ mandates

  async createMandate(p: Principal, body: unknown): Promise<{ mandate: Mandate; agent_key: string | null }> {
    const accountId = this.requireOwner(p);
    const input = parse(MandateCreate, body);
    for (const o of input.scope.outcomes) this.capabilities.get(o);
    const now = this.now();
    if (new Date(input.expires_at) <= now) throw errors.invalid('expires_at must be in the future');
    const mandate: MandateDoc = {
      id: newId('mdt'),
      object: 'mandate',
      account_id: accountId,
      label: input.label ?? null,
      status: 'active',
      scope: input.scope,
      spent: 0,
      reserved: 0,
      expires_at: input.expires_at,
      revoked_at: null,
      created_at: iso(now),
    };
    const raw = input.issue_agent_key ? newApiKey() : null;
    await this.d.store.tx(async (tx) => {
      await tx.insert('mandates', mandate);
      if (raw) await tx.insert('api_keys', this.keyDoc(raw, 'agent', accountId, mandate.id, input.label ?? `agent for ${mandate.id}`));
    });
    return { mandate: withRemaining(mandate), agent_key: raw };
  }

  async listMandates(p: Principal): Promise<Mandate[]> {
    const accountId = this.requireBuyer(p);
    const rows = await this.d.store.tx((tx) => tx.find('mandates', { account_id: accountId }, { order: 'desc' }));
    return rows.filter((m) => p.role === 'owner' || m.id === p.mandate_id).map(withRemaining);
  }

  async getMandate(p: Principal, id: string): Promise<Mandate> {
    const accountId = this.requireBuyer(p);
    const m = await this.d.store.tx((tx) => tx.get('mandates', id));
    if (!m || m.account_id !== accountId || (p.role === 'agent' && p.mandate_id !== id)) throw errors.notFound('Mandate');
    return withRemaining(m);
  }

  /** Stops new spend and kills the mandate's agent keys. In-flight tasks continue; cancel them separately. */
  async revokeMandate(p: Principal, id: string): Promise<Mandate> {
    const accountId = this.requireOwner(p);
    return this.d.store.tx(async (tx) => {
      const m = await tx.get('mandates', id, { forUpdate: true });
      if (!m || m.account_id !== accountId) throw errors.notFound('Mandate');
      if (m.status === 'active') {
        m.status = 'revoked';
        m.revoked_at = iso(this.now());
        await tx.update('mandates', m);
        for (const k of await tx.find('api_keys', { parent_id: id, status: 'active' })) {
          await tx.update('api_keys', { ...k, status: 'revoked' });
        }
      }
      return withRemaining(m);
    });
  }

  // ================================================================ operator (fulfilment side)

  async operatorStart(p: Principal, id: string, body: unknown): Promise<Task> {
    this.requireOperator(p);
    const input = parse(OperatorNote, body ?? {});
    return this.txn(async (ctx) => {
      const { task, before } = await this.loadTask(ctx, id);
      await this.transition(ctx, task, 'working', input.note ?? 'Work started');
      await this.saveTask(ctx, task, before);
      return task;
    });
  }

  async operatorRequestInput(p: Principal, id: string, body: unknown): Promise<Task> {
    this.requireOperator(p);
    const input = parse(OperatorInputRequest, body);
    return this.txn(async (ctx) => {
      const { task, before } = await this.loadTask(ctx, id);
      if (!isOpen(task.status)) throw errors.invalidState(`Cannot request input on a ${task.status} task`);
      const request = { id: newId('inp'), question: input.question, fields: input.fields, requested_at: iso(ctx.now), answered_at: null, answers: null };
      task.input_requests.push(request);
      await this.transition(ctx, task, 'needs_input', input.question);
      await ctx.emit(task, 'task.input_required', { input_request: request });
      await this.saveTask(ctx, task, before);
      return task;
    });
  }

  async operatorDeliver(p: Principal, id: string, body: unknown): Promise<Delivery> {
    this.requireOperator(p);
    const input = parse(OperatorDelivery, body);
    await this.reconcileTask(id);
    return this.txn(async (ctx) => {
      const { tx, now } = ctx;
      const { task, before } = await this.loadTask(ctx, id);
      if (!isOpen(task.status)) throw errors.invalidState(`Task is ${task.status}; not accepting deliveries`);
      if (task.progress.remaining <= 0) throw errors.invalidState('All units are already delivered or pending acceptance');

      const capability = this.capabilities.get(task.outcome);
      const result = parse(capability.result, input.result, `result for ${capability.id}`);
      const prior = await tx.find('deliveries', { parent_id: task.id }, { limit: 1000 });
      const checks = capability.check({ intent: task.intent, result, evidence: input.evidence, prior, now });
      if (checks.some((c) => c.result === 'fail')) {
        throw errors.unprocessable('delivery_nonconforming', 'Delivery does not meet the task contract', { checks });
      }

      const occursAt = capability.occursAt(result);
      const anchor =
        task.terms.acceptance_anchor === 'occurs_at' && occursAt && new Date(occursAt) > now ? new Date(occursAt) : now;
      const delivery: Delivery = {
        id: newId('dlv'),
        object: 'delivery',
        task_id: task.id,
        account_id: task.account_id,
        outcome: task.outcome,
        summary: capability.summarize(result),
        result: result as Record<string, unknown>,
        evidence: input.evidence,
        checks,
        status: 'pending_acceptance',
        amount: task.unit_amount,
        currency: task.currency,
        occurs_at: occursAt,
        acceptance_window_ends_at: iso(later(anchor, task.terms.acceptance_window_hours * HOUR)),
        decision: null,
        settlement_id: null,
        created_at: iso(now),
      };
      await tx.insert('deliveries', delivery);
      task.progress.pending += 1;
      this.recount(task);
      await ctx.emit(task, 'delivery.created', { delivery });
      if (task.progress.remaining === 0) await this.transition(ctx, task, 'delivered', `All ${task.quantity} units delivered`);
      else if (task.status === 'queued') await this.transition(ctx, task, 'working', 'First delivery landed');
      await this.saveTask(ctx, task, before);
      return delivery;
    });
  }

  async operatorFail(p: Principal, id: string, body: unknown): Promise<Task> {
    this.requireOperator(p);
    const input = parse(OperatorFail, body);
    return this.txn(async (ctx) => {
      const { task, before } = await this.loadTask(ctx, id);
      await this.transition(ctx, task, 'failed', input.reason);
      await this.saveTask(ctx, task, before);
      return task;
    });
  }

  // ================================================================ admin

  private keyDoc(raw: string, role: Role, accountId: string | null, mandateId: string | null, label: string | null): ApiKey {
    return {
      id: newId('key'),
      object: 'api_key',
      account_id: accountId,
      mandate_id: mandateId,
      role,
      key_hash: sha256(raw),
      label,
      status: 'active',
      created_at: iso(this.now()),
    };
  }

  async adminCreateAccount(body: unknown) {
    const input = parse(AccountCreate, body);
    const account: Account = {
      id: newId('acct'),
      object: 'account',
      name: input.name,
      stripe_customer_id: input.stripe_customer_id ?? null,
      webhook_secret: newWebhookSecret(),
      created_at: iso(this.now()),
    };
    const owner = newApiKey();
    await this.d.store.tx(async (tx) => {
      await tx.insert('accounts', account);
      await tx.insert('api_keys', this.keyDoc(owner, 'owner', account.id, null, 'owner'));
    });
    const { webhook_secret, ...rest } = account;
    return { account: rest, owner_key: owner, webhook_secret };
  }

  async adminUpdateAccount(id: string, body: unknown) {
    const input = parse(AccountUpdate, body);
    return this.d.store.tx(async (tx) => {
      const a = await tx.get('accounts', id, { forUpdate: true });
      if (!a) throw errors.notFound('Account');
      if (input.name !== undefined) a.name = input.name;
      if (input.stripe_customer_id !== undefined) a.stripe_customer_id = input.stripe_customer_id;
      await tx.update('accounts', a);
      const { webhook_secret: _, ...rest } = a;
      return rest;
    });
  }

  async adminCreateOperatorKey(body: unknown) {
    const input = parse(OperatorKeyCreate, body ?? {});
    const raw = newApiKey();
    const doc = this.keyDoc(raw, 'operator', null, null, input.label ?? 'operator');
    await this.d.store.tx((tx) => tx.insert('api_keys', doc));
    return { id: doc.id, role: doc.role, label: doc.label, key: raw };
  }

  /** Dev/demo only: creates an account and keys with known values. Idempotent. */
  async seedDemo(keys: { owner: string; operator: string }) {
    const existing = await this.authenticate(keys.owner);
    if (existing) return;
    const account: Account = {
      id: 'acct_demo',
      object: 'account',
      name: 'Demo buyer',
      stripe_customer_id: null,
      webhook_secret: 'whsec_demo',
      created_at: iso(this.now()),
    };
    await this.d.store.tx(async (tx) => {
      await tx.insert('accounts', account);
      await tx.insert('api_keys', this.keyDoc(keys.owner, 'owner', account.id, null, 'demo owner'));
      await tx.insert('api_keys', this.keyDoc(keys.operator, 'operator', null, null, 'demo operator'));
    });
  }

  // ================================================================ scheduler

  /** Auto-accepts deliveries past their window and expires tasks past their deadline. */
  async reconcileTask(taskId: string): Promise<void> {
    const snapshot = await this.d.store.tx(async (tx) => {
      const task = await tx.get('tasks', taskId);
      if (!task) return null;
      return { task, pending: await tx.find('deliveries', { parent_id: taskId, status: 'pending_acceptance' }, { limit: 1000 }) };
    });
    if (!snapshot) return;
    const now = this.now();
    for (const d of snapshot.pending) {
      if (new Date(d.acceptance_window_ends_at) <= now) await this.autoAccept(d.id);
    }
    if (isOpen(snapshot.task.status) && new Date(snapshot.task.deadline) <= now) await this.expireTask(taskId);
  }

  private async autoAccept(deliveryId: string): Promise<boolean> {
    try {
      await this.decide(null, deliveryId, async (ctx, task, d) => {
        if (new Date(d.acceptance_window_ends_at) > ctx.now) throw errors.invalidState('Acceptance window still open');
        await this.settle(ctx, task, d, { by: 'system', reason_code: null, note: 'Acceptance window elapsed' });
      });
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) return false;
      throw e;
    }
  }

  private async expireTask(taskId: string): Promise<boolean> {
    return this.txn(async (ctx) => {
      const { task, before } = await this.loadTask(ctx, taskId);
      if (!isOpen(task.status) || new Date(task.deadline) > ctx.now) return false;
      const delivered = task.progress.pending + task.progress.accepted;
      await this.transition(ctx, task, 'expired', `Deadline passed with ${delivered} of ${task.quantity} delivered`);
      await this.saveTask(ctx, task, before);
      return true;
    });
  }

  private async deliverWebhook(id: string): Promise<void> {
    const w = await this.d.store.tx((tx) => tx.get('webhooks', id));
    if (!w || w.status !== 'pending') return;
    const secret =
      w.target === 'operator'
        ? (this.d.config.operatorWebhookSecret ?? '')
        : ((await this.d.store.tx((tx) => tx.get('accounts', w.account_id)))?.webhook_secret ?? '');
    const res = await send(this.d.fetch ?? fetch, w.url, secret, w.payload, this.now());
    await this.d.store.tx(async (tx) => {
      const cur = await tx.get('webhooks', id, { forUpdate: true });
      if (!cur || cur.status !== 'pending') return;
      cur.attempts += 1;
      if (res.ok) {
        cur.status = 'delivered';
        cur.next_attempt_at = null;
        cur.last_error = null;
      } else {
        const delay = backoffMs(cur.attempts);
        cur.last_error = res.error;
        cur.status = delay === undefined ? 'failed' : 'pending';
        cur.next_attempt_at = delay === undefined ? null : iso(later(this.now(), delay));
      }
      await tx.update('webhooks', cur);
    });
  }

  private async charge(settlementId: string): Promise<void> {
    const ctx0 = await this.d.store.tx(async (tx) => {
      const s = await tx.get('settlements', settlementId);
      if (!s || s.status === 'succeeded') return null;
      const [account, delivery] = await Promise.all([tx.get('accounts', s.account_id), tx.get('deliveries', s.delivery_id)]);
      return account && delivery ? { s, account, delivery } : null;
    });
    if (!ctx0) return;
    const res = await this.d.payments.charge({
      settlement: ctx0.s,
      account: ctx0.account,
      description: `${ctx0.delivery.outcome}: ${ctx0.delivery.summary}`,
    });
    await this.txn(async (ctx) => {
      const task = await ctx.tx.get('tasks', ctx0.s.task_id);
      const s = await ctx.tx.get('settlements', settlementId, { forUpdate: true });
      if (!task || !s || s.status === 'succeeded') return;
      s.attempts += 1;
      s.updated_at = iso(ctx.now);
      if (res.ok) {
        s.status = 'succeeded';
        s.provider_ref = res.ref;
        s.last_error = null;
        s.next_attempt_at = null;
      } else {
        const delay = SETTLEMENT_BACKOFF[s.attempts - 1];
        s.status = 'failed';
        s.last_error = res.error;
        s.next_attempt_at = delay === undefined ? null : iso(later(ctx.now, delay));
      }
      await ctx.tx.update('settlements', s);
      await ctx.emit(task, res.ok ? 'settlement.succeeded' : 'settlement.failed', {
        settlement: s,
        will_retry: s.next_attempt_at !== null,
      });
    });
  }

  /** One scheduler pass. Run from cron; reads also reconcile lazily, so this mostly covers webhooks and quiet tasks. */
  async tick(limit = 200) {
    const now = this.now();
    const due = await this.d.store.tx(async (tx) => ({
      deliveries: await tx.due('deliveries', now, limit),
      tasks: await tx.due('tasks', now, limit),
      quotes: await tx.due('quotes', now, limit),
      webhooks: await tx.due('webhooks', now, limit),
      settlements: await tx.due('settlements', now, limit),
    }));
    const report = { deliveries_auto_accepted: 0, tasks_expired: 0, quotes_expired: 0, webhooks_attempted: 0, settlements_attempted: 0 };
    for (const d of due.deliveries) if (await this.autoAccept(d.id)) report.deliveries_auto_accepted++;
    for (const t of due.tasks) if (await this.expireTask(t.id)) report.tasks_expired++;
    for (const q of due.quotes) {
      await this.d.store.tx(async (tx) => {
        const cur = await tx.get('quotes', q.id, { forUpdate: true });
        if (cur?.status === 'open' && new Date(cur.expires_at) <= now) {
          await tx.update('quotes', { ...cur, status: 'expired' });
          report.quotes_expired++;
        }
      });
    }
    await this.drain();
    for (const w of due.webhooks) {
      await this.deliverWebhook(w.id);
      report.webhooks_attempted++;
    }
    for (const s of due.settlements) {
      await this.charge(s.id);
      report.settlements_attempted++;
    }
    await this.drain();
    return report;
  }
}
