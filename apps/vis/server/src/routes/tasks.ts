import { Hono } from 'hono';

import { KIMI_CODE_HOME } from '../config';
import type { BackgroundTaskEntry } from '../lib/agent-record-types';
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

  // List background tasks (process / agent / question) for a session. Tasks are
  // persisted under each spawning agent's homedir (`<homedir>/tasks`), NOT the
  // session root, so aggregate across every agent in the session.
  r.get('/:id/tasks', async (c) => {
    const id = c.req.param('id');
    const detail = await readSessionDetail(home, id);
    if (!detail) {
      return c.json({ error: 'session not found', code: 'NOT_FOUND' }, 404);
    }
    const entries: BackgroundTaskEntry[] = [];
    for (const agent of detail.agents) {
      const tasks = await listBackgroundTasks(agent.homedir);
      for (const task of tasks) {
        const outputSizeBytes = await taskOutputSizeBytes(agent.homedir, task.taskId);
        entries.push({ task, agentId: agent.agentId, outputSizeBytes, outputExists: outputSizeBytes > 0 });
      }
    }
    // Newest first across all agents.
    entries.sort((a, b) => (b.task.startedAt ?? 0) - (a.task.startedAt ?? 0));
    return c.json({ sessionId: id, tasks: entries });
  });

  // Read a byte-window of a single task's output.log. The task may belong to
  // any agent, so locate the agent whose tasks/ directory holds it.
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
    // Prefer the agent whose log actually has bytes; otherwise any agent's dir
    // yields the same empty window. An explicit ?agent= short-circuits the scan.
    const hinted = c.req.query('agent');
    let dir = detail.agents.find((a) => a.agentId === hinted)?.homedir ?? detail.agents[0]?.homedir ?? detail.sessionDir;
    for (const agent of detail.agents) {
      if ((await taskOutputSizeBytes(agent.homedir, taskId)) > 0) {
        dir = agent.homedir;
        break;
      }
    }
    const window = await readTaskOutput(dir, taskId, offset, limit);
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
