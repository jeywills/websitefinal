const SYMBOL: Record<string, string> = { gbp: '£', usd: '$', eur: '€' };

/** 37500, 'gbp' → "£375"; 1234567 → "£12,345.67" */
export function fmt(amount: number, currency: string): string {
  const value = (amount / 100).toLocaleString('en-GB', {
    minimumFractionDigits: amount % 100 ? 2 : 0,
    maximumFractionDigits: 2,
  });
  return `${SYMBOL[currency] ?? `${currency.toUpperCase()} `}${value}`;
}
