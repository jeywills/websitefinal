# Outcome API

State a goal, constraints and budget. The server quotes it, works on it asynchronously, and bills only on delivery.

```
Intent ──► Quote ──► Task ──► Delivery (+ evidence) ──► Settlement
                       ▲
                    Mandate  (scoped, expiring spend delegation from a human)
```

- **REST** `/v1/*` · **MCP** `POST /mcp` · **A2A** `/.well-known/agent-card.json` · **OpenAPI** `/openapi.json` · **JSON Schema** `/schemas/outcome.json`
- Ships one outcome: `meeting.booked` (qualified first meetings, priced per seniority tier, acceptance window anchored on the meeting time).
- Full protocol: [`docs/SPEC.md`](docs/SPEC.md)

## Run it

```bash
npm install
npm run dev            # http://localhost:8787, in-memory store, demo keys printed
npm run demo           # walks mandate → quote → task → input → delivery → settlement with curl
npm test               # 34 tests; lifecycle suite runs on memory and on real Postgres (PGlite)
npm run typecheck
```

Demo keys (memory store only): owner `ok_demo_owner`, operator `ok_demo_operator`.

## Layout

| Path | What |
|---|---|
| `src/core/schemas.ts` | The contract. Every object, once, in zod → JSON Schema / OpenAPI / MCP tool schemas |
| `src/core/service.ts` | Quote, commit, deliver, accept/reject, settle, reconcile. All state changes are transactional and emit events |
| `src/core/capabilities/` | Outcome types. `meeting-booked.ts` holds pricing, capacity model and delivery checks |
| `src/core/mandates.ts` | Scope envelope checks and budget maths |
| `src/core/state.ts` | Task state machine |
| `src/store/` | `MemoryStore` (dev/tests) and `PostgresStore` (prod) behind one `Tx` interface |
| `src/payments/` | `ledger` and `stripe` (invoice item per accepted unit, idempotent) |
| `src/http/` | Hono app: REST, SSE, MCP, A2A, OpenAPI, docs page |
| `db/migrations/` | SQL, in its own `outcome` schema with RLS on |

## Deploy (Vercel + Supabase)

1. **Database.** Create a Supabase project. Copy the *Transaction pooler* connection string (port 6543).
   ```bash
   DATABASE_URL=postgres://... npm run db:migrate
   ```
   Tables live in the `outcome` schema, which PostgREST doesn't expose; RLS is enabled as a second guard.
2. **Vercel.** Import the repo. Zero-config Hono picks up `src/index.ts`. Set env vars from `.env.example`: at minimum `DATABASE_URL`, `OUTCOME_ADMIN_TOKEN`, `CRON_SECRET`, `PUBLIC_BASE_URL`.
3. **Bootstrap.**
   ```bash
   curl -X POST $BASE/admin/accounts -H "Authorization: Bearer $OUTCOME_ADMIN_TOKEN" \
     -H "Content-Type: application/json" -d '{"name":"InterNex Capital","stripe_customer_id":"cus_..."}'
   # → owner_key + webhook_secret (shown once)
   curl -X POST $BASE/admin/operator-keys -H "Authorization: Bearer $OUTCOME_ADMIN_TOKEN" -d '{"label":"n8n"}'
   ```
4. **Billing.** Set `STRIPE_SECRET_KEY`. Each accepted unit becomes an invoice item on the account's Stripe customer; invoice monthly.
5. **Cron.** `vercel.json` runs `/cron/tick` daily (Hobby limit). On Pro, change it to `*/5 * * * *` so auto-accepts and webhook retries land promptly. Reads also reconcile lazily, so nothing is lost in between.

Production refuses to boot without `DATABASE_URL`: the memory store would lose data between serverless instances.

## Fulfilment side (n8n)

Point `OPERATOR_WEBHOOK_URL` at an n8n webhook. Every task event arrives signed. A minimal workflow:

1. `task.created` → create the HubSpot deal / Smartlead campaign from `data.task.intent`
2. Meeting booked → `POST /v1/operator/tasks/{id}/deliveries` with the attendee, company, `scheduled_at` and a `calendar_invite` evidence item
3. Need something from the client → `POST /v1/operator/tasks/{id}/request-input`

Deliveries that fail the contract (wrong geo/industry, excluded domain, duplicate company, no invite) are refused with `422` and the failing checks, so the workflow can route them back for review.

## Plug an agent in

**Claude / any MCP client:** add a remote MCP server at `https://<host>/mcp` with header `Authorization: Bearer <agent key>`.
**A2A agents:** point them at `https://<host>/.well-known/agent-card.json`.

The agent key is bound to one mandate: it can quote anything but can only commit inside the mandate's budget, ICP envelope and expiry.
