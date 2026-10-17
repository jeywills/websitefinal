import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type IdPrefix = 'acct' | 'key' | 'mdt' | 'qte' | 'tsk' | 'dlv' | 'stl' | 'evt' | 'whk' | 'inp';

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomBytes(12).toString('base64url')}`;
}

/** Bearer API key. Shown once; only its sha256 is stored. */
export function newApiKey(): string {
  return `ok_${randomBytes(24).toString('base64url')}`;
}

export function newWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('base64url')}`;
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hmacSha256(secret: string, input: string): string {
  return createHmac('sha256', secret).update(input).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
