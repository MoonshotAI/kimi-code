import { Hono } from 'hono';
import { KIMI_CODE_HOME } from '../config';
import { readSessionDetail } from '../lib/session-store';
import { buildAgentTree } from '../lib/agent-tree';

export function subagentsRoute(home: string = KIMI_CODE_HOME): Hono {
  const r = new Hono();
  r.get('/:id/agents', async (c) => {
    const id = c.req.param('id');
    const detail = await readSessionDetail(home, id);
    if (!detail) {
      return c.json({ error: 'session not found', code: 'NOT_FOUND' }, 404);
    }
    return c.json({ sessionId: id, tree: buildAgentTree(detail.agents) });
  });
  return r;
}
