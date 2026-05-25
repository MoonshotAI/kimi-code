import { Hono } from 'hono';
import { rm } from 'node:fs/promises';
import { KIMI_CODE_HOME } from '../config';
import { listSessions } from '../lib/session-store';

export function sessionsRoute(): Hono {
  const r = new Hono();
  r.get('/', async (c) => {
    const sessions = await listSessions(KIMI_CODE_HOME);
    return c.json({ sessions });
  });
  r.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const all = await listSessions(KIMI_CODE_HOME);
    const target = all.find((s) => s.sessionId === id);
    if (!target) return c.json({ error: 'session not found', code: 'NOT_FOUND' }, 404);
    await rm(target.sessionDir, { recursive: true, force: true });
    return c.json({ sessionId: id, deleted: true });
  });
  return r;
}
