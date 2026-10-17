import { hmacSha256, safeEqual } from './core/ids.js';
import type { OutcomeEvent } from './core/schemas.js';

export const SIGNATURE_HEADER = 'outcome-signature';

/** Stripe-style: `t=<unix>,v1=<hex hmac_sha256(secret, "<t>.<body>")>`. */
export function sign(secret: string, body: string, now: Date): string {
  const t = Math.floor(now.getTime() / 1000);
  return `t=${t},v1=${hmacSha256(secret, `${t}.${body}`)}`;
}

/** For receivers (and tests): verify a webhook body against its signature header. */
export function verify(secret: string, header: string, body: string, now = new Date(), toleranceSeconds = 300): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const t = Number(parts.t);
  if (!parts.v1 || !Number.isFinite(t) || Math.abs(now.getTime() / 1000 - t) > toleranceSeconds) return false;
  return safeEqual(parts.v1, hmacSha256(secret, `${t}.${body}`));
}

export type SendResult = { ok: true } | { ok: false; error: string };

export async function send(fetchImpl: typeof fetch, url: string, secret: string, event: OutcomeEvent, now: Date): Promise<SendResult> {
  const body = JSON.stringify(event);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'outcome-api/0.1',
        [SIGNATURE_HEADER]: sign(secret, body, now),
        'outcome-event-id': event.id,
        'outcome-event-type': event.type,
      },
      body,
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Delay before attempt n+1 (n = attempts so far). Undefined = give up. */
export function backoffMs(attempts: number): number | undefined {
  return [30_000, 120_000, 600_000, 3_600_000, 21_600_000][attempts - 1];
}
