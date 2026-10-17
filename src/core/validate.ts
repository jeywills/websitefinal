import { z } from 'zod';
import { errors } from './errors.js';

export function parse<T>(schema: z.ZodType<T>, body: unknown, what = 'request body'): T {
  const r = schema.safeParse(body);
  if (!r.success) throw errors.invalid(`Invalid ${what}`, z.treeifyError(r.error));
  return r.data;
}
