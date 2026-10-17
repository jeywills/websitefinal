import { z } from 'zod';
import type { CapabilityRegistry } from '../core/capabilities/index.js';
import {
  Delivery,
  DeliveryReject,
  InputResponse,
  Mandate,
  MandateCreate,
  OperatorDelivery,
  OperatorFail,
  OperatorInputRequest,
  OperatorNote,
  OutcomeEvent,
  Quote,
  Settlement,
  Task,
  TaskCreate,
} from '../core/schemas.js';

const ErrorBody = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});

function json(schema: z.ZodType, io: 'input' | 'output' = 'output') {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, { io, unrepresentable: 'any' }) as Record<string, unknown>;
  return rest;
}

function components(registry: CapabilityRegistry) {
  return {
    Intent: json(registry.intentSchema(), 'input'),
    Quote: json(Quote),
    Task: json(Task),
    Delivery: json(Delivery),
    Settlement: json(Settlement),
    Mandate: json(Mandate),
    Event: json(OutcomeEvent),
    Error: json(ErrorBody),
    TaskCreate: json(TaskCreate, 'input'),
    InputResponse: json(InputResponse, 'input'),
    DeliveryReject: json(DeliveryReject, 'input'),
    MandateCreate: json(MandateCreate, 'input'),
    OperatorNote: json(OperatorNote, 'input'),
    OperatorInputRequest: json(OperatorInputRequest, 'input'),
    OperatorDelivery: json(OperatorDelivery, 'input'),
    OperatorFail: json(OperatorFail, 'input'),
  };
}

/** The whole contract as one JSON Schema document. */
export function jsonSchemaBundle(registry: CapabilityRegistry, baseUrl: string) {
  const defs = components(registry);
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${baseUrl}/schemas/outcome.json`,
    title: 'Outcome API contract',
    description: 'Intent → Quote → Task → Delivery → Settlement, under a Mandate.',
    $defs: {
      ...defs,
      ...Object.fromEntries(
        registry.list().flatMap((c) => [
          [`${c.id}.constraints`, json(c.constraints, 'input')],
          [`${c.id}.result`, json(c.result, 'input')],
        ]),
      ),
    },
  };
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const listOf = (name: string) => ({
  type: 'object',
  properties: { object: { const: 'list' }, data: { type: 'array', items: ref(name) } },
});

interface Op {
  summary: string;
  tag: string;
  body?: string;
  response?: object | string;
  status?: number;
  idempotent?: boolean;
  params?: string[];
  query?: Record<string, string>;
  description?: string;
}

function operation(o: Op) {
  const status = String(o.status ?? 200);
  const schema = typeof o.response === 'string' ? ref(o.response) : (o.response ?? { type: 'object' });
  return {
    summary: o.summary,
    tags: [o.tag],
    ...(o.description ? { description: o.description } : {}),
    parameters: [
      ...(o.params ?? []).map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } })),
      ...Object.entries(o.query ?? {}).map(([name, description]) => ({ name, in: 'query', required: false, description, schema: { type: 'string' } })),
      ...(o.idempotent
        ? [{ name: 'Idempotency-Key', in: 'header', required: false, description: 'Safe retries: same key + same body replays the first response', schema: { type: 'string' } }]
        : []),
    ],
    ...(o.body ? { requestBody: { required: true, content: { 'application/json': { schema: ref(o.body) } } } } : {}),
    responses: {
      [status]: { description: 'OK', content: { 'application/json': { schema } } },
      default: { description: 'Error', content: { 'application/json': { schema: ref('Error') } } },
    },
  };
}

export function openApiDocument(registry: CapabilityRegistry, baseUrl: string, providerName: string) {
  const p = (o: Op) => operation({ ...o, idempotent: true });
  return {
    openapi: '3.1.0',
    info: {
      title: `${providerName} Outcome API`,
      version: '0.1.0',
      description:
        'State a goal, constraints and budget. Get a quote with feasibility, price and ETA. Commit and the server works ' +
        'asynchronously, reporting through task events. You pay only for deliveries you accept (or that auto-accept ' +
        'when the acceptance window closes). Amounts are integers in minor units.',
    },
    servers: [{ url: baseUrl }],
    security: [{ bearer: [] }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } }, schemas: components(registry) },
    paths: {
      '/v1/capabilities': {
        get: { ...operation({ summary: 'List purchasable outcomes', tag: 'Discovery' }), security: [] },
      },
      '/v1/quotes': { post: p({ summary: 'Quote an intent', tag: 'Quotes', body: 'Intent', response: 'Quote', status: 201 }) },
      '/v1/quotes/{id}': { get: operation({ summary: 'Get a quote', tag: 'Quotes', params: ['id'], response: 'Quote' }) },
      '/v1/tasks': {
        post: p({ summary: 'Commit to a quote', tag: 'Tasks', body: 'TaskCreate', response: 'Task', status: 201 }),
        get: operation({ summary: 'List tasks', tag: 'Tasks', response: listOf('Task'), query: { status: 'Comma-separated statuses', limit: 'Max results' } }),
      },
      '/v1/tasks/{id}': { get: operation({ summary: 'Get a task with its deliveries', tag: 'Tasks', params: ['id'], response: 'Task' }) },
      '/v1/tasks/{id}/cancel': { post: p({ summary: 'Cancel a task', tag: 'Tasks', params: ['id'], body: 'OperatorNote', response: 'Task' }) },
      '/v1/tasks/{id}/input': { post: p({ summary: 'Answer an input request', tag: 'Tasks', params: ['id'], body: 'InputResponse', response: 'Task' }) },
      '/v1/tasks/{id}/events': {
        get: operation({
          summary: 'Task events (JSON page, or SSE with Accept: text/event-stream)',
          tag: 'Tasks',
          params: ['id'],
          query: { after: 'Return events with seq greater than this', timeout: 'SSE: seconds to hold the stream open' },
          response: listOf('Event'),
        }),
      },
      '/v1/tasks/{id}/deliveries': { get: operation({ summary: 'List deliveries', tag: 'Deliveries', params: ['id'], response: listOf('Delivery') }) },
      '/v1/deliveries/{id}': { get: operation({ summary: 'Get a delivery', tag: 'Deliveries', params: ['id'], response: 'Delivery' }) },
      '/v1/deliveries/{id}/accept': { post: p({ summary: 'Accept (and pay for) a delivery', tag: 'Deliveries', params: ['id'], response: 'Delivery' }) },
      '/v1/deliveries/{id}/reject': {
        post: p({ summary: 'Reject a delivery inside its window', tag: 'Deliveries', params: ['id'], body: 'DeliveryReject', response: 'Delivery' }),
      },
      '/v1/settlements': { get: operation({ summary: 'List settlements', tag: 'Settlements', query: { task_id: 'Filter by task' }, response: listOf('Settlement') }) },
      '/v1/mandates': {
        post: p({
          summary: 'Create a mandate (owner key)',
          tag: 'Mandates',
          body: 'MandateCreate',
          status: 201,
          response: { type: 'object', properties: { mandate: ref('Mandate'), agent_key: { type: ['string', 'null'] } } },
          description: 'Scoped, expiring spend delegation. Returns a one-time agent key that can only act inside it.',
        }),
        get: operation({ summary: 'List mandates', tag: 'Mandates', response: listOf('Mandate') }),
      },
      '/v1/mandates/{id}': { get: operation({ summary: 'Get a mandate', tag: 'Mandates', params: ['id'], response: 'Mandate' }) },
      '/v1/mandates/{id}/revoke': { post: p({ summary: 'Revoke a mandate and its agent keys', tag: 'Mandates', params: ['id'], response: 'Mandate' }) },
      '/v1/operator/tasks': {
        get: operation({ summary: 'Work queue (operator key)', tag: 'Operator', query: { status: 'Defaults to queued,working,needs_input' }, response: listOf('Task') }),
      },
      '/v1/operator/tasks/{id}/start': { post: p({ summary: 'Mark working', tag: 'Operator', params: ['id'], body: 'OperatorNote', response: 'Task' }) },
      '/v1/operator/tasks/{id}/request-input': {
        post: p({ summary: 'Ask the buyer for input', tag: 'Operator', params: ['id'], body: 'OperatorInputRequest', response: 'Task' }),
      },
      '/v1/operator/tasks/{id}/deliveries': {
        post: p({
          summary: 'Submit a delivery with evidence',
          tag: 'Operator',
          params: ['id'],
          body: 'OperatorDelivery',
          response: 'Delivery',
          status: 201,
          description: 'Checked against the task contract; any failing check rejects it with 422 delivery_nonconforming.',
        }),
      },
      '/v1/operator/tasks/{id}/fail': { post: p({ summary: 'Fail a task', tag: 'Operator', params: ['id'], body: 'OperatorFail', response: 'Task' }) },
    },
  };
}
