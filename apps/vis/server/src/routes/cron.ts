import { Hono } from 'hono';

import { KIMI_CODE_HOME } from '../config';
import { readSessionDetail } from '../lib/session-store';
import { listCronTasks } from '../lib/cron-store';

export function cronRoute(home: string = KIMI_CODE_HOME): Hono {
  const r = new Hono();
  r.get('/:id/cron', async (c) => {
    const id = c.req.param('id');
    const detail = await readSessionDetail(home, id);
    if (!detail) {
      return c.json({ error: 'session not found', code: 'NOT_FOUND' }, 404);
    }
    const cron = await listCronTasks(detail.sessionDir);
    return c.json({ sessionId: id, cron });
  });
  return r;
}
