import type { Account, Settlement } from '../core/schemas.js';

export type ChargeResult = { ok: true; ref: string } | { ok: false; error: string };

export interface PaymentProvider {
  name: string;
  /** Must be idempotent on settlement.id: it is retried after failures and timeouts. */
  charge(input: { settlement: Settlement; account: Account; description: string }): Promise<ChargeResult>;
}
