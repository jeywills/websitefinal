#!/usr/bin/env bash
# Walks the whole contract against a running server (npm run dev).
# Uses the demo keys the in-memory store seeds. Requires curl + jq.
set -euo pipefail
BASE=${BASE:-http://localhost:8787}
OWNER=${OWNER:-ok_demo_owner}
OP=${OP:-ok_demo_operator}
j() { curl -sS -H "Content-Type: application/json" "$@"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

step "1. Owner delegates: £2,000, UK fintech only, 14 days"
EXPIRES=$(date -u -d '+14 days' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+14d +%Y-%m-%dT%H:%M:%SZ)
M=$(j "$BASE/v1/mandates" -H "Authorization: Bearer $OWNER" -d "{
  \"label\": \"Outbound agent\",
  \"scope\": {\"outcomes\": [\"meeting.booked\"], \"currency\": \"gbp\", \"max_total\": 200000,
            \"constraints\": {\"geo\": [\"GB\"], \"industries\": [\"fintech\"]}},
  \"expires_at\": \"$EXPIRES\"}")
AGENT=$(echo "$M" | jq -r .agent_key); echo "$M" | jq '{mandate: .mandate.id, remaining: .mandate.remaining}'

step "2. Agent asks for 20 meetings → quote"
INTENT='{"outcome":"meeting.booked","quantity":20,"constraints":{"geo":["GB"],"industries":["fintech"],"titles":["CFO","COO"]},"budget":{"currency":"gbp","max_unit_price":37500}}'
Q=$(j "$BASE/v1/quotes" -H "Authorization: Bearer $AGENT" -d "$INTENT")
echo "$Q" | jq '{feasibility: .feasibility.status, likely: .feasibility.likely_quantity, unit: .price.unit_amount, mandate_ok: .mandate_check.ok, why: .mandate_check.violations}'

step "3. Mandate covers 5, so re-quote for 5 and commit"
Q=$(j "$BASE/v1/quotes" -H "Authorization: Bearer $AGENT" -d "$(echo "$INTENT" | jq '.quantity = 5')")
T=$(j "$BASE/v1/tasks" -H "Authorization: Bearer $AGENT" -H "Idempotency-Key: demo-$(date +%s)" -d "{\"quote_id\": \"$(echo "$Q" | jq -r .id)\"}")
TASK=$(echo "$T" | jq -r .id); echo "$T" | jq '{task: .id, status, committed: .billing.committed}'

step "4. Operator asks a question; agent answers"
R=$(j "$BASE/v1/operator/tasks/$TASK/request-input" -H "Authorization: Bearer $OP" -d '{"question":"Any accounts to exclude?","fields":[{"name":"exclude_domains"}]}')
REQ=$(echo "$R" | jq -r '.input_requests[0].id'); echo "$R" | jq '{status}'
j "$BASE/v1/tasks/$TASK/input" -H "Authorization: Bearer $AGENT" -d "{\"request_id\":\"$REQ\",\"answers\":{\"exclude_domains\":[\"monzo.com\"]}}" | jq '{status}'

step "5. Operator delivers a meeting with evidence (checked against the intent)"
AT=$(date -u -d '+3 days' +%Y-%m-%dT10:00:00Z 2>/dev/null || date -u -v+3d +%Y-%m-%dT10:00:00Z)
D=$(j "$BASE/v1/operator/tasks/$TASK/deliveries" -H "Authorization: Bearer $OP" -d "{
  \"result\": {\"attendee\": {\"name\": \"Sam Patel\", \"title\": \"CFO\", \"email\": \"sam@lendco.co.uk\"},
             \"company\": {\"name\": \"LendCo\", \"domain\": \"lendco.co.uk\", \"country\": \"GB\", \"industry\": \"fintech\", \"employees\": 180},
             \"scheduled_at\": \"$AT\"},
  \"evidence\": [{\"type\": \"calendar_invite\", \"uri\": \"https://calendar.example/e/1\"}]}")
DLV=$(echo "$D" | jq -r .id); echo "$D" | jq '{delivery: .id, summary, window_ends: .acceptance_window_ends_at, checks: [.checks[] | "\(.name): \(.result)"]}'

step "6. Agent accepts → billed"
j -X POST "$BASE/v1/deliveries/$DLV/accept" -H "Authorization: Bearer $AGENT" | jq '{status, settlement_id}'
sleep 0.3
j "$BASE/v1/mandates/$(echo "$M" | jq -r .mandate.id)" -H "Authorization: Bearer $AGENT" | jq '{spent, reserved, remaining}'

step "7. Event log"
j "$BASE/v1/tasks/$TASK/events" -H "Authorization: Bearer $AGENT" | jq -r '.data[] | "\(.seq)  \(.type)"'

step "8. Same flow over MCP"
j "$BASE/mcp" -H "Authorization: Bearer $AGENT" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq -r '.result.tools[].name' | paste -sd' ' -
