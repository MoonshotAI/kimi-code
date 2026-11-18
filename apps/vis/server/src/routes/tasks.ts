import { Hono } from 'hono';

import { KIMI_CODE_HOME } from '../config';
import type { BackgroundTaskEntry } from '../lib/agent-record-types';
import { readSessionDetail } from '../lib/session-store';
import {
  isSafeTaskId,
  listBackgroundTasks,
  readTaskOutput,
  taskOutputMetadata,
} from '../lib/task-store';

const DEFAULT_OUTPUT_LIMIT = 256 * 1024;
const MAX_OUTPUT_LIMIT = 4 * 1024 * 1024;

export function tasksRoute(home: string = KIMI_CODE_HOME): Hono {
  const r = new Hono();

  r.get('/:id/tasks', async (c) => {
    const id = c.req.param('id');
    const detail = await readSessionDetail(home, id);
    if (!detail) {
      return c.json({ error: 'session not found', code: 'NOT_FOUND' }, 404);
    }
    const entries: BackgroundTaskEntry[] = [];
    for (const agent of detail.agents) {
      const fallbackDir = agent.agentId === 'main' ? detail.sessionDir : undefined;
      const tasks = await listBackgroundTasks(agent.homedir, fallbackDir);
      for (const task of tasks) {
        const output = await taskOutputMetadata(agent.homedir, task.taskId, fallbackDir);
        entries.push({
          task,
          agentId: agent.agentId,
          outputSizeBytes: output.size,
          outputExists: output.exists,
        });
      }
    }
    entries.sort((a, b) => (b.task.startedAt ?? 0) - (a.task.startedAt ?? 0));
    return c.json({ sessionId: id, tasks: entries });
  });

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
    const hinted = c.req.query('agent');
    const hintedAgent = detail.agents.find((agent) => agent.agentId === hinted);
    let owner = hintedAgent ?? detail.agents[0];
    if (hintedAgent === undefined) {
      for (const agent of detail.agents) {
        const fallbackDir = agent.agentId === 'main' ? detail.sessionDir : undefined;
        if ((await taskOutputMetadata(agent.homedir, taskId, fallbackDir)).exists) {
          owner = agent;
          break;
        }
      }
    }
    const dir = owner?.homedir ?? detail.sessionDir;
    const fallbackDir = owner?.agentId === 'main' ? detail.sessionDir : undefined;
    const window = await readTaskOutput(dir, taskId, offset, limit, fallbackDir);
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
