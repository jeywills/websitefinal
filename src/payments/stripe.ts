import type { PaymentProvider } from './types.js';

/**
 * Bills each accepted unit as a Stripe invoice item on the account's customer.
 * Items roll into the customer's next invoice (subscription cycle, or create one
 * from pending items on your billing day). The settlement id is the idempotency
 * key, so retries never double-bill.
 */
export function stripeProvider(secretKey: string, fetchImpl: typeof fetch = fetch): PaymentProvider {
  return {
    name: 'stripe',
    async charge({ settlement, account, description }) {
      if (!account.stripe_customer_id) return { ok: false, error: `account ${account.id} has no stripe_customer_id` };
      const body = new URLSearchParams({
        customer: account.stripe_customer_id,
        amount: String(settlement.amount),
        currency: settlement.currency,
        description,
        'metadata[settlement_id]': settlement.id,
        'metadata[delivery_id]': settlement.delivery_id,
        'metadata[task_id]': settlement.task_id,
      });
      try {
        const res = await fetchImpl('https://api.stripe.com/v1/invoiceitems', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${secretKey}`,
            'content-type': 'application/x-www-form-urlencoded',
            'idempotency-key': `outcome_${settlement.id}`,
          },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        const json = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
        if (res.ok && json.id) return { ok: true, ref: json.id };
        return { ok: false, error: json.error?.message ?? `stripe responded ${res.status}` };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
