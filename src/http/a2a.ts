/**
 * A2A (Agent2Agent) JSON-RPC binding, protocol 0.3. Outcome tasks map onto A2A
 * tasks; deliveries are artifacts. Callers send structured DataParts:
 *   {"action":"quote","intent":{...}}            → Message carrying the quote
 *   {"action":"create_task","quote_id":"qte_…"}  → Task
 *   {"action":"respond_input","request_id":…,"answers":{…}} with message.taskId → Task
 *   {"action":"accept_delivery"|"reject_delivery","delivery_id":…} → Task
 */
import type { Context } from 'hono';
import type { CapabilityRegistry } from '../core/capabilities/index.js';
import { ApiError, errors } from '../core/errors.js';
import { newId } from '../core/ids.js';
import type { TaskStatus } from '../core/schemas.js';
import { isTerminal } from '../core/state.js';
import type { OutcomeService, Principal, TaskWithDeliveries } from '../core/service.js';

const STATE: Record<TaskStatus, string> = {
  queued: 'submitted',
  working: 'working',
  needs_input: 'input-required',
  delivered: 'completed',
  expired: 'completed', // partial delivery is final; see metadata.outcome_status
  cancelled: 'canceled',
  failed: 'failed',
};

function toA2ATask(t: TaskWithDeliveries) {
  const open = t.input_requests.find((r) => !r.answered_at);
  return {
    kind: 'task',
    id: t.id,
    contextId: t.id,
    status: {
      state: STATE[t.status],
      timestamp: t.updated_at,
      ...(open || t.status_reason
        ? {
            message: {
              kind: 'message',
              role: 'agent',
              messageId: newId('evt'),
              taskId: t.id,
              contextId: t.id,
              parts: [
                { kind: 'text', text: open ? open.question : t.status_reason },
                ...(open ? [{ kind: 'data', data: { input_request: open } }] : []),
              ],
            },
          }
        : {}),
    },
    artifacts: t.deliveries.map((d) => ({
      artifactId: d.id,
      name: d.summary,
      description: `${d.outcome} delivery (${d.status})`,
      parts: [{ kind: 'data', data: d }],
    })),
    metadata: {
      outcome_status: t.status,
      progress: t.progress,
      billing: t.billing,
      unit_amount: t.unit_amount,
      currency: t.currency,
      deadline: t.deadline,
    },
  };
}

type Rpc = { jsonrpc: '2.0'; id?: string | number | null; method?: string; params?: any };

const ok = (id: Rpc['id'], result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result });
const fail = (id: Rpc['id'], code: number, message: string, data?: unknown) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, data } });

function rpcError(id: Rpc['id'], e: ApiError) {
  const code = e.status === 400 ? -32602 : e.status === 404 ? -32001 : -32010;
  return fail(id, code, e.message, e.toJSON().error);
}

async function send(service: OutcomeService, p: Principal, params: any) {
  const message = params?.message;
  const data = message?.parts?.find((part: any) => part?.kind === 'data')?.data;
  if (!data || typeof data !== 'object') {
    throw errors.invalid('Send a DataPart with an action; free text is not accepted. See the agent card skills for examples.');
  }
  const action: string =
    data.action ?? (data.intent ? 'quote' : data.quote_id ? 'create_task' : data.request_id ? 'respond_input' : '');
  const taskId: string | undefined = message.taskId ?? data.task_id;
  switch (action) {
    case 'quote': {
      const quote = await service.createQuote(p, data.intent);
      const f = quote.feasibility;
      return {
        kind: 'message',
        role: 'agent',
        messageId: newId('evt'),
        contextId: message.contextId ?? quote.id,
        parts: [
          { kind: 'text', text: `${f.status}: likely ${f.likely_quantity} of ${f.requested_quantity}, ${quote.price.unit_amount} ${quote.price.currency} minor units each. Quote ${quote.id}.` },
          { kind: 'data', data: quote },
        ],
      };
    }
    case 'create_task': {
      const task = await service.createTask(p, { quote_id: data.quote_id, mandate_id: data.mandate_id, callback_url: data.callback_url });
      return toA2ATask(await service.getTask(p, task.id));
    }
    case 'respond_input': {
      if (!taskId) throw errors.invalid('message.taskId is required to answer an input request');
      await service.respondInput(p, taskId, { request_id: data.request_id, answers: data.answers });
      return toA2ATask(await service.getTask(p, taskId));
    }
    case 'accept_delivery':
    case 'reject_delivery': {
      const d =
        action === 'accept_delivery'
          ? await service.acceptDelivery(p, data.delivery_id)
          : await service.rejectDelivery(p, data.delivery_id, { reason_code: data.reason_code, note: data.note });
      return toA2ATask(await service.getTask(p, d.task_id));
    }
    default:
      throw errors.invalid(`Unknown action "${action}"`, { actions: ['quote', 'create_task', 'respond_input', 'accept_delivery', 'reject_delivery'] });
  }
}

export function a2aHandler(service: OutcomeService) {
  return async (c: Context<{ Variables: { principal: Principal } }>) => {
    let msg: Rpc;
    try {
      msg = await c.req.json();
    } catch {
      return c.json(fail(null, -32700, 'Parse error'));
    }
    if (msg?.jsonrpc !== '2.0' || typeof msg.method !== 'string') return c.json(fail(msg?.id, -32600, 'Invalid Request'));
    const p = c.get('principal');
    try {
      switch (msg.method) {
        case 'message/send':
          return c.json(ok(msg.id, await send(service, p, msg.params)));
        case 'tasks/get':
          return c.json(ok(msg.id, toA2ATask(await service.getTask(p, msg.params?.id))));
        case 'tasks/cancel': {
          const before = await service.getTask(p, msg.params?.id);
          const notCancelable = (data?: unknown) => c.json(fail(msg.id, -32002, `Task is ${before.status} and cannot be canceled`, data));
          if (isTerminal(before.status)) return notCancelable();
          try {
            await service.cancelTask(p, before.id, {});
          } catch (e) {
            if (e instanceof ApiError && e.status === 409) return notCancelable(e.toJSON().error);
            throw e;
          }
          return c.json(ok(msg.id, toA2ATask(await service.getTask(p, before.id))));
        }
        case 'message/stream':
        case 'tasks/resubscribe':
          return c.json(fail(msg.id, -32004, 'Streaming is not supported over A2A; use GET /v1/tasks/{id}/events (SSE) or webhooks'));
        case 'tasks/pushNotificationConfig/set':
        case 'tasks/pushNotificationConfig/get':
          return c.json(fail(msg.id, -32003, 'Push notifications: pass callback_url when creating the task'));
        default:
          return c.json(fail(msg.id, -32601, `Method not found: ${msg.method}`));
      }
    } catch (e) {
      if (e instanceof ApiError) return c.json(rpcError(msg.id, e));
      throw e;
    }
  };
}

export function agentCard(capabilities: CapabilityRegistry, baseUrl: string, providerName: string) {
  return {
    protocolVersion: '0.3.0',
    name: `${providerName} Outcome API`,
    description:
      'Buy business outcomes, not API calls. State a goal, constraints and budget; get a quote; commit; ' +
      'the work runs asynchronously and you pay only per accepted delivery. ' +
      `Also available as MCP (${baseUrl}/mcp) and REST (${baseUrl}/openapi.json).`,
    url: `${baseUrl}/a2a`,
    preferredTransport: 'JSONRPC',
    additionalInterfaces: [{ url: `${baseUrl}/a2a`, transport: 'JSONRPC' }],
    version: '0.1.0',
    provider: { organization: providerName, url: baseUrl },
    documentationUrl: `${baseUrl}/`,
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    securitySchemes: {
      bearer: {
        type: 'http',
        scheme: 'bearer',
        description: 'API key. Agent keys are bound to one mandate (spend cap, scope, expiry) set by a human owner.',
      },
    },
    security: [{ bearer: [] }],
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: capabilities.list().map((c) => ({
      id: c.id,
      name: c.name,
      description: `${c.description} Send a DataPart {"action":"quote","intent":{...}}, then {"action":"create_task","quote_id":"..."}.`,
      tags: ['outcome', c.unit, 'pay-per-outcome'],
      examples: [JSON.stringify({ action: 'quote', intent: c.example })],
      inputModes: ['application/json'],
      outputModes: ['application/json'],
    })),
  };
}

