import { Hono } from 'hono';
import { join } from 'node:path';

import { KIMI_CODE_HOME } from '../config';
import { isSafeAgentId, readSessionDetail } from '../lib/session-store';
import { readAgentWire } from '../lib/wire-reader';
import { projectContext } from '../lib/context-projector';

export function contextRoute(): Hono {
  const r = new Hono();
  r.get('/:id/context', async (c) => {
    const id = c.req.param('id');
    const agentId = c.req.query('agent') ?? 'main';
    if (!isSafeAgentId(agentId)) {
      return c.json({ error: 'invalid agent id', code: 'BAD_REQUEST' }, 400);
    }
    const detail = await readSessionDetail(KIMI_CODE_HOME, id);
    if (!detail) {
      return c.json({ error: 'session not found', code: 'NOT_FOUND' }, 404);
    }
    const agent = detail.agents.find((a) => a.agentId === agentId);
    if (!agent || !agent.wireExists) {
      return c.json({ error: 'agent wire not found', code: 'NOT_FOUND' }, 404);
    }
    try {
      const wire = await readAgentWire(
        join(detail.sessionDir, 'agents', agentId, 'wire.jsonl'),
      );
      const proj = projectContext(wire.records);
      return c.json({
        sessionId: id,
        agentId,
        messages: proj.messages,
        usage: proj.usage,
        config: proj.config,
        permission: proj.permission,
        planMode: proj.planMode,
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.toLowerCase().includes('unsupported protocol')) {
        return c.json({ error: msg, code: 'UNSUPPORTED_PROTOCOL' }, 400);
      }
      return c.json({ error: msg, code: 'READ_ERROR' }, 500);
    }
  });
  return r;
}
