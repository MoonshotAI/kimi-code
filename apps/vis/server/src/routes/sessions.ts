import { Hono } from 'hono';
import { rm } from 'node:fs/promises';
import { KIMI_CODE_HOME } from '../config';
import { revealInOs } from '../lib/reveal';
import { listSessions, readSessionDetail } from '../lib/session-store';

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
  // Open the session directory in the OS file manager. The folder is
  // opened on the SERVER host — only meaningful when vis runs locally.
  r.post('/:id/reveal', async (c) => {
    const id = c.req.param('id');
    const detail = await readSessionDetail(KIMI_CODE_HOME, id);
    if (!detail) return c.json({ error: 'session not found', code: 'NOT_FOUND' }, 404);
    try {
      await revealInOs(detail.sessionDir);
      return c.json({ sessionId: id, opened: detail.sessionDir });
    } catch (err) {
      return c.json(
        { error: `failed to open: ${(err as Error).message}`, code: 'READ_ERROR' },
        500,
      );
    }
  });
  return r;
}
