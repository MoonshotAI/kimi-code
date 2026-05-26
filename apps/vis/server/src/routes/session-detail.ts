import { Hono } from 'hono';
import { KIMI_CODE_HOME } from '../config';
import { readSessionDetail } from '../lib/session-store';

export function sessionDetailRoute(): Hono {
  const r = new Hono();
  r.get('/:id', async (c) => {
    const id = c.req.param('id');
    const detail = await readSessionDetail(KIMI_CODE_HOME, id);
    if (!detail) return c.json({ error: 'session not found', code: 'NOT_FOUND' }, 404);
    return c.json(detail);
  });
  return r;
}
