import type { PaymentProvider } from './types.js';

/** Records settlements without moving money. Invoice from the settlements list. */
export const ledgerProvider: PaymentProvider = {
  name: 'ledger',
  async charge({ settlement }) {
    return { ok: true, ref: `ledger:${settlement.id}` };
  },
};
