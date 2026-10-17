// Vercel entry: Hono app as the default export (zero-config Hono detection).
import { createFromEnv } from './deps.js';
import { createApp } from './http/app.js';

const { service, options } = createFromEnv();

export default createApp(service, options);
