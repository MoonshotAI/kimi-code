import { Hono } from 'hono';
import { join } from 'node:path';

import { KIMI_CODE_HOME } from '../config';
import { isSafeAgentId, readSessionDetail } from '../lib/session-store';
import { rehydrateWireEntries } from '../lib/blob-resolver';
import { readAgentWire } from '../lib/wire-reader';
import { projectContext } from '../lib/context-projector';

export function contextRoute(home: string = KIMI_CODE_HOME): Hono {
  const r = new Hono();
  r.get('/:id/context', async (c) => {
    const id = c.req.param('id');
    const agentId = c.req.query('agent') ?? 'main';
    if (!isSafeAgentId(agentId)) {
      return c.json({ error: 'invalid agent id', code: 'BAD_REQUEST' }, 400);
    }
    const detail = await readSessionDetail(home, id);
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
      const baseUrl = new URL(c.req.url).origin;
      rehydrateWireEntries(wire.records, id, agentId, baseUrl);
      // `?history=full` reconstructs the FULL pre-compaction/undo/clear history
      // for debugging; the default mirrors the model's-eye post-compaction view.
      const mode = c.req.query('history') === 'full' ? 'full' : 'model';
      const proj = projectContext(wire.records, mode);
      return c.json({
        sessionId: id,
        agentId,
        messages: proj.messages,
        usage: proj.usage,
        contextTokens: proj.contextTokens,
        config: proj.config,
        permission: proj.permission,
        planMode: proj.planMode,
        goal: proj.goal,
        swarm: proj.swarm,
      });
    } catch (err) {
      const msg = (err as Error).message;
      return c.json({ error: msg, code: 'READ_ERROR' }, 500);
    }
  });
  return r;
}
