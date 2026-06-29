import { Hono } from 'hono';

import { KIMI_CODE_HOME } from '../config';
import { readSessionDetail } from '../lib/session-store';
import {
  isSafeTaskId,
  listBackgroundTasks,
  readTaskOutput,
  taskOutputSizeBytes,
} from '../lib/task-store';

/** Default output-log window size: 256 KiB. Large enough to show a whole
 *  typical log in one fetch, bounded so a multi-MB log pages instead of
 *  loading wholesale. Overridable via `?limit=`. */
const DEFAULT_OUTPUT_LIMIT = 256 * 1024;
const MAX_OUTPUT_LIMIT = 4 * 1024 * 1024;

export function tasksRoute(home: string = KIMI_CODE_HOME): Hono {
  const r = new Hono();

  // List background tasks (process / agent / question) for a session.
  r.get('/:id/tasks', async (c) => {
    const id = c.req.param('id');
    const detail = await readSessionDetail(home, id);
    if (!detail) {
      return c.json({ error: 'session not found', code: 'NOT_FOUND' }, 404);
    }
    const tasks = await listBackgroundTasks(detail.sessionDir);
    const entries = await Promise.all(
      tasks.map(async (task) => {
        const outputSizeBytes = await taskOutputSizeBytes(detail.sessionDir, task.taskId);
        return { task, outputSizeBytes, outputExists: outputSizeBytes > 0 };
      }),
    );
    return c.json({ sessionId: id, tasks: entries });
  });

  // Read a byte-window of a single task's output.log.
  r.get('/:id/tasks/:taskId/output', async (c) => {
    const id = c.req.param('id');
    const taskId = c.req.param('taskId');
    if (!isSafeTaskId(taskId)) {
      return c.json({ error: 'invalid task id', code: 'BAD_REQUEST' }, 400);
    }
    const offset = parseNonNegativeInt(c.req.query('offset'), 0);
    const limit = Math.min(
      parseNonNegativeInt(c.req.query('limit'), DEFAULT_OUTPUT_LIMIT),
      MAX_OUTPUT_LIMIT,
    );
    const detail = await readSessionDetail(home, id);
    if (!detail) {
      return c.json({ error: 'session not found', code: 'NOT_FOUND' }, 404);
    }
    const window = await readTaskOutput(detail.sessionDir, taskId, offset, limit);
    return c.json({
      sessionId: id,
      taskId,
      offset: window.offset,
      nextOffset: window.nextOffset,
      size: window.size,
      content: window.content,
      eof: window.eof,
    });
  });

  return r;
}

function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
