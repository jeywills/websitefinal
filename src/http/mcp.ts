/**
 * Stateless MCP server over Streamable HTTP (JSON responses, no sessions).
 * Any MCP client — Claude, Cursor, an n8n agent node — can buy outcomes with
 * the same Bearer key it would use for REST.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { ApiError } from '../core/errors.js';
import { DeliveryReject, InputResponse, TaskCreate } from '../core/schemas.js';
import type { OutcomeService, Principal } from '../core/service.js';

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

interface Tool {
  name: string;
  title: string;
  description: string;
  input: z.ZodType | (() => object);
  readOnly?: boolean;
  run(s: OutcomeService, p: Principal, args: any): Promise<unknown>;
}

const TaskRef = z.object({ task_id: z.string() });
const DeliveryRef = z.object({ delivery_id: z.string() });

function tools(service: OutcomeService): Tool[] {
  return [
    {
      name: 'list_outcomes',
      title: 'List purchasable outcomes',
      description: 'Outcome types this server sells, with their constraint schema, terms and an example intent.',
      input: z.object({}),
      readOnly: true,
      run: async (s) => ({ outcomes: s.capabilities.describe() }),
    },
    {
      name: 'get_quote',
      title: 'Quote an outcome',
      description:
        'Price a goal before committing. Send an intent (outcome, quantity, constraints, budget, optional deadline). ' +
        'Returns feasibility (likely quantity by deadline), unit price, ETA, acceptance terms and, for agent keys, ' +
        'whether your mandate covers it. Nothing is reserved or charged.',
      input: () => ({ type: 'object', properties: { intent: z.toJSONSchema(service.capabilities.intentSchema(), { io: 'input' }) }, required: ['intent'] }),
      readOnly: true,
      run: (s, p, a) => s.createQuote(p, a.intent),
    },
    {
      name: 'create_task',
      title: 'Commit to a quote',
      description:
        'Turns an open, feasible quote into a task the server works on asynchronously. Reserves quantity × unit price ' +
        'against the mandate; billing happens only per delivery that is accepted (or auto-accepted after the window).',
      input: TaskCreate,
      run: (s, p, a) => s.createTask(p, a),
    },
    {
      name: 'get_task',
      title: 'Get task status and deliveries',
      description: 'Status (queued → working → needs_input → delivered), progress, open input requests and every delivery with its evidence and checks.',
      input: TaskRef,
      readOnly: true,
      run: (s, p, a) => s.getTask(p, a.task_id),
    },
    {
      name: 'list_tasks',
      title: 'List tasks',
      description: 'Your tasks, newest first. Optional comma-separated status filter.',
      input: z.object({ status: z.string().optional() }),
      readOnly: true,
      run: async (s, p, a) => ({ tasks: await s.listTasks(p, { status: a.status }) }),
    },
    {
      name: 'respond_to_input',
      title: 'Answer an input request',
      description: 'When a task is needs_input, answer the open input request so work resumes.',
      input: InputResponse.extend({ task_id: z.string() }),
      run: (s, p, { task_id, ...body }) => s.respondInput(p, task_id, body),
    },
    {
      name: 'accept_delivery',
      title: 'Accept a delivery',
      description: 'Accept a pending delivery; it is billed immediately. Unanswered deliveries auto-accept when their window ends.',
      input: DeliveryRef,
      run: (s, p, a) => s.acceptDelivery(p, a.delivery_id),
    },
    {
      name: 'reject_delivery',
      title: 'Reject a delivery',
      description: 'Reject a pending delivery inside its acceptance window (e.g. no_show, off_icp). Not billed; the slot reopens.',
      input: DeliveryReject.extend({ delivery_id: z.string() }),
      run: (s, p, { delivery_id, ...body }) => s.rejectDelivery(p, delivery_id, body),
    },
    {
      name: 'cancel_task',
      title: 'Cancel a task',
      description: 'Stop work. Pending deliveries still go through acceptance; unused reservation is released.',
      input: TaskRef.extend({ note: z.string().optional() }),
      run: (s, p, a) => s.cancelTask(p, a.task_id, { note: a.note }),
    },
    {
      name: 'get_mandate',
      title: 'Check mandate budget',
      description: 'Spend scope, spent, reserved and remaining budget. Agent keys default to their own mandate.',
      input: z.object({ mandate_id: z.string().optional() }),
      readOnly: true,
      run: async (s, p, a) => {
        const id = a.mandate_id ?? p.mandate_id;
        return id ? s.getMandate(p, id) : { mandates: await s.listMandates(p) };
      },
    },
  ];
}

type Rpc = { jsonrpc: '2.0'; id?: string | number | null; method?: string; params?: any };

const ok = (id: Rpc['id'], result: unknown) => ({ jsonrpc: '2.0', id, result });
const fail = (id: Rpc['id'], code: number, message: string, data?: unknown) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, data } });

export function mcpHandler(service: OutcomeService, providerName: string) {
  const all = tools(service);
  const schemaOf = (t: Tool) => (typeof t.input === 'function' ? t.input() : z.toJSONSchema(t.input as z.ZodType, { io: 'input' }));
  const listed = () =>
    all.map((t) => {
      const { $schema: _, ...inputSchema } = schemaOf(t) as Record<string, unknown>;
      return {
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema,
        annotations: { readOnlyHint: !!t.readOnly, destructiveHint: false, openWorldHint: true },
      };
    });

  async function handle(msg: Rpc, p: Principal) {
    if (msg?.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(msg?.id, -32600, 'Invalid Request');
    if (msg.id === undefined) return null; // notification (e.g. notifications/initialized)
    switch (msg.method) {
      case 'initialize': {
        const requested = msg.params?.protocolVersion;
        return ok(msg.id, {
          protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'outcome-api', title: `${providerName} Outcome API`, version: '0.1.0' },
          instructions:
            'Buy outcomes, not actions. Flow: list_outcomes → get_quote → create_task → poll get_task ' +
            '(answer needs_input with respond_to_input) → accept_delivery / reject_delivery. You pay only for accepted deliveries.',
        });
      }
      case 'ping':
        return ok(msg.id, {});
      case 'tools/list':
        return ok(msg.id, { tools: listed() });
      case 'tools/call': {
        const tool = all.find((t) => t.name === msg.params?.name);
        if (!tool) return fail(msg.id, -32602, `Unknown tool: ${msg.params?.name}`);
        try {
          const out = await tool.run(service, p, msg.params?.arguments ?? {});
          return ok(msg.id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out, isError: false });
        } catch (e) {
          if (!(e instanceof ApiError)) throw e;
          return ok(msg.id, { content: [{ type: 'text', text: JSON.stringify(e.toJSON(), null, 2) }], isError: true });
        }
      }
      default:
        return fail(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  }

  return async (c: Context<{ Variables: { principal: Principal } }>) => {
    let body: Rpc | Rpc[];
    try {
      body = await c.req.json();
    } catch {
      return c.json(fail(null, -32700, 'Parse error'), 400);
    }
    const p = c.get('principal');
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => handle(m, p)))).filter((r) => r !== null);
      return out.length ? c.json(out) : c.body(null, 202);
    }
    const out = await handle(body, p);
    return out === null ? c.body(null, 202) : c.json(out);
  };
}
