import { Hono } from 'hono';

export function wireRoute(): Hono {
  const r = new Hono();
  r.all('*', (c) => c.json({ error: 'not_implemented', code: 'NOT_FOUND' }, 501));
  return r;
}
