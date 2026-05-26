import { Hono } from 'hono';
import { join } from 'node:path';

import { KIMI_CODE_HOME } from '../config';
import { isSafeAgentId, readSessionDetail } from '../lib/session-store';
import { readAgentWire } from '../lib/wire-reader';

export function wireRoute(): Hono {
  const r = new Hono();
  r.get('/:id/wire', async (c) => {
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
    if (!agent) {
      return c.json({ error: `agent "${agentId}" not found`, code: 'NOT_FOUND' }, 404);
    }
    if (!agent.wireExists) {
      return c.json({ error: 'wire missing', code: 'NOT_FOUND' }, 404);
    }
    try {
      const result = await readAgentWire(
        join(detail.sessionDir, 'agents', agentId, 'wire.jsonl'),
      );
      return c.json({
        sessionId: id,
        agentId,
        protocolVersion: result.metadata.protocolVersion,
        metadata: result.metadata,
        records: result.records,
        warnings: result.warnings,
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
