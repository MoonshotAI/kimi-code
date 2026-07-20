import { Hono } from 'hono';

import { KIMI_CODE_HOME } from '../config';
import type { CronTask } from '../lib/agent-record-types';
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
    // Cron jobs are persisted under each (non-sub) agent's homedir at
    // `<homedir>/cron`, not the session root. Aggregate across agents; sub
    // agents have no cron directory and simply contribute nothing.
    const cron: CronTask[] = [];
    const seen = new Set<string>();
    for (const agent of detail.agents) {
      for (const job of await listCronTasks(agent.homedir)) {
        if (seen.has(job.id)) continue;
        seen.add(job.id);
        cron.push(job);
      }
    }
    cron.sort((a, b) => a.createdAt - b.createdAt);
    return c.json({ sessionId: id, cron });
  });
  return r;
}
