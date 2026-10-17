import type { CapabilityRegistry } from '../core/capabilities/index.js';
import { fmt } from '../core/money.js';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function docsPage(o: { baseUrl: string; providerName: string; capabilities: CapabilityRegistry }) {
  const b = esc(o.baseUrl);
  const example = o.capabilities.list()[0]?.example;
  const outcomes = o.capabilities
    .list()
    .map(
      (c) =>
        `<tr><td><code>${esc(c.id)}</code></td><td>${esc(c.description)}</td><td>${c.terms.acceptance_window_hours}h from ${
          c.terms.acceptance_anchor === 'occurs_at' ? 'when it happens' : 'delivery'
        }</td></tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.providerName)} Outcome API</title>
<meta name="description" content="State a goal, constraints and budget. Get a quote. Pay only on delivery.">
<style>
:root { --bg:#fbfaf7; --fg:#16140f; --muted:#6b665c; --line:#e4e0d6; --code:#f1eee6; --accent:#1f5f4a; }
@media (prefers-color-scheme: dark) { :root { --bg:#12110e; --fg:#ece8df; --muted:#9a9488; --line:#2a2822; --code:#1c1b17; --accent:#7cc3a6; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 56px 16px 96px; }
h1 { font-size: clamp(2rem, 5vw, 2.8rem); line-height:1.1; margin:0 0 12px; letter-spacing:-0.02em; }
h2 { font-size:1.15rem; margin:48px 0 12px; }
p.lede { font-size:1.2rem; color:var(--muted); margin:0 0 24px; }
a { color:var(--accent); }
code, pre { font: 13.5px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
code { background:var(--code); padding:1px 5px; border-radius:4px; }
pre { background:var(--code); padding:16px; border-radius:8px; overflow-x:auto; border:1px solid var(--line); }
pre code { background:none; padding:0; }
table { width:100%; border-collapse:collapse; font-size:15px; }
th, td { text-align:left; vertical-align:top; padding:10px 8px; border-bottom:1px solid var(--line); }
th { color:var(--muted); font-weight:600; font-size:13px; text-transform:uppercase; letter-spacing:.04em; }
.flow { font-family: ui-monospace, monospace; font-size:14px; color:var(--muted); }
.flow b { color:var(--fg); font-weight:600; }
ul { padding-left: 20px; }
.links { display:flex; flex-wrap:wrap; gap:8px 20px; margin-top:8px; }
@media (max-width: 600px) { th:nth-child(3), td:nth-child(3) { display:none; } }
</style>
</head>
<body>
<main>
<h1>Outcome API</h1>
<p class="lede">State a goal, constraints and budget. The server quotes it, works on it asynchronously, and bills only on delivery.</p>
<div class="links">
  <a href="${b}/openapi.json">OpenAPI</a>
  <a href="${b}/schemas/outcome.json">JSON Schema</a>
  <a href="${b}/.well-known/agent-card.json">A2A agent card</a>
  <span>MCP: <code>${b}/mcp</code></span>
</div>

<h2>Why</h2>
<ul>
  <li>REST, GraphQL and MCP are action interfaces. The caller has to know the steps.</li>
  <li>Agents are bad at orchestrating fifteen calls reliably; vendors are bad at exposing their value as one call.</li>
  <li>Nothing standard covers outcome, price and proof in one contract. This does.</li>
</ul>

<h2>Primitives</h2>
<table>
<tr><th>Primitive</th><th>What it does</th><th>Example</th></tr>
<tr><td><b>Intent</b></td><td>Goal + constraints + max spend</td><td>20 meetings, UK fintech, CFO/COO, max £375 each</td></tr>
<tr><td><b>Quote</b></td><td>Feasibility, price, ETA</td><td>Likely 14 in 30 days, £375 each</td></tr>
<tr><td><b>Task</b></td><td>Long-running job with state and events</td><td><span class="flow">queued → working → needs_input → delivered</span></td></tr>
<tr><td><b>Delivery</b></td><td>Result plus evidence, checked against the intent</td><td>Meeting booked, calendar invite, source trail</td></tr>
<tr><td><b>Settlement</b></td><td>Pay per accepted outcome, with a dispute window</td><td>Accept / reject; auto-accept 72h after the meeting</td></tr>
<tr><td><b>Mandate</b></td><td>Scoped, expiring delegation from a human</td><td>Spend ≤ £2k, this ICP only, until month end</td></tr>
</table>

<h2>Outcomes on sale</h2>
<table><tr><th>Outcome</th><th>Description</th><th>Acceptance window</th></tr>${outcomes}</table>

<h2>Quickstart</h2>
<pre><code># 1. Quote (nothing reserved, nothing charged)
curl -s ${b}/v1/quotes -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '${esc(JSON.stringify(example ?? {}))}'

# 2. Commit: reserves ${example ? esc(fmt(example.budget.max_unit_price * example.quantity, example.budget.currency)) : 'quantity × unit'} against your mandate
curl -s ${b}/v1/tasks -H "Authorization: Bearer $KEY" -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" -d '{"quote_id":"qte_…","callback_url":"https://you.example/hooks/outcome"}'

# 3. Follow it: poll, stream (SSE) or take signed webhooks
curl -sN ${b}/v1/tasks/tsk_…/events -H "Authorization: Bearer $KEY" -H "Accept: text/event-stream"

# 4. Accept or reject each delivery inside its window; only accepted ones are billed
curl -s -X POST ${b}/v1/deliveries/dlv_…/reject -H "Authorization: Bearer $KEY" \\
  -H "Content-Type: application/json" -d '{"reason_code":"no_show"}'</code></pre>

<h2>Rules of the contract</h2>
<ul>
  <li>Amounts are integers in minor units (37500 = £375).</li>
  <li>Committing reserves <code>quantity × unit price</code> against the mandate. Unused reservation is released when the task ends.</li>
  <li>Every delivery is checked against the intent before the buyer sees it; a failing check is refused at the door.</li>
  <li>Billing is per accepted unit. Silence inside the window means acceptance.</li>
  <li>Agent keys belong to one mandate and can never exceed its budget, scope or expiry.</li>
  <li>Webhooks are signed (<code>Outcome-Signature: t=…,v1=HMAC-SHA256</code>) and delivered at least once.</li>
  <li>All POSTs accept <code>Idempotency-Key</code>.</li>
</ul>
</main>
</body>
</html>`;
}
