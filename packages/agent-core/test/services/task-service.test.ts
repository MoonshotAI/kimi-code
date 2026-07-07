/**
 * `TaskService` (Chain 8 / P1.8, W9.2) unit tests.
 *
 * Hermetic: mocks `ICoreProcessService` with an in-memory `rpc` proxy. Coverage:
 *   - kind mapping (process/agent/question → bash/subagent/tool)
 *   - status mapping (running/completed/failed/timed_out/killed/lost → wire)
 *   - timestamp synthesis (created_at = started_at from startedAt; completed_at
 *     omitted when endedAt is null)
 *   - list/get/cancel happy paths
 *   - TaskNotFoundError → 40406 (list miss + get miss + cancel miss)
 *   - TaskAlreadyFinishedError → 40904 (cancel on terminal status)
 *   - SessionNotFoundError → 40401 (session existence check)
 */

import { describe, expect, it } from 'vitest';

import type {
  BackgroundTaskInfo,
  CoreRPC,
  SessionSummary,
  StopBackgroundPayload,
} from '../../src';

import {
  type ICoreProcessService,
  SessionNotFoundError,
  TaskAlreadyFinishedError,
  TaskNotFoundError,
  TaskService,
  toProtocolTask,
} from '../../src/services';

interface FakeState {
  sessions: SessionSummary[];
  tasksBySession: Map<string, BackgroundTaskInfo[]>;
  outputByTaskId: Map<string, string>;
  stopCalls: Array<StopBackgroundPayload & { sessionId: string; agentId: string }>;
}

function makeBridge(state: FakeState): ICoreProcessService {
  const rpc: Partial<CoreRPC> = {
    listSessions: async () => state.sessions,
    getBackground: async (p: { sessionId: string; agentId: string; activeOnly?: boolean }) =>
      state.tasksBySession.get(p.sessionId) ?? [],
    getBackgroundOutput: async (p: { sessionId: string; agentId: string; taskId: string; tail?: number }) => {
      const output = state.outputByTaskId.get(p.taskId);
      if (output === undefined) return '';
      if (p.tail !== undefined && output.length > p.tail) {
        return output.slice(-p.tail);
      }
      return output;
    },
    stopBackground: async (
      p: StopBackgroundPayload & { sessionId: string; agentId: string },
    ) => {
      state.stopCalls.push(p);
    },
  };
  return {
    rpc: rpc as CoreRPC,
    ready: async () => undefined,
    dispose: () => undefined,
    _serviceBrand: undefined,
  };
}

function session(id: string): SessionSummary {
  return {
    id,
    workDir: '/tmp',
    sessionDir: `/tmp/sd-${id}`,
    createdAt: 0,
    updatedAt: 0,
  };
}

function bashTask(
  taskId: string,
  status: BackgroundTaskInfo['status'],
  endedAt: number | null = null,
): BackgroundTaskInfo {
  return {
    taskId,
    kind: 'process',
    description: 'pnpm install',
    status,
    startedAt: 1_000_000,
    endedAt,
    command: 'pnpm install',
    pid: 1234,
    exitCode: status === 'completed' ? 0 : null,
  };
}

function fresh(): FakeState {
  return { sessions: [], tasksBySession: new Map(), outputByTaskId: new Map(), stopCalls: [] };
}

// --- Adapter --------------------------------------------------------------

describe('toProtocolTask adapter', () => {
  it('maps process → bash with synthesized created_at/started_at', () => {
    const out = toProtocolTask('s1', bashTask('t1', 'running'));
    expect(out.kind).toBe('bash');
    expect(out.status).toBe('running');
    expect(out.session_id).toBe('s1');
    expect(out.id).toBe('t1');
    expect(out.created_at).toBe(out.started_at);
    expect(out.created_at.endsWith('Z')).toBe(true);
    expect(out.completed_at).toBeUndefined();
  });

  it('surfaces completed_at when endedAt is set', () => {
    const out = toProtocolTask('s1', bashTask('t1', 'completed', 1_001_000));
    expect(out.status).toBe('completed');
    expect(out.completed_at).toBe(new Date(1_001_000).toISOString());
  });

  it("maps 'timed_out' → 'failed' (lossy)", () => {
    const out = toProtocolTask('s1', bashTask('t1', 'timed_out'));
    expect(out.status).toBe('failed');
  });

  it("maps 'killed' → 'cancelled'", () => {
    const out = toProtocolTask('s1', bashTask('t1', 'killed'));
    expect(out.status).toBe('cancelled');
  });

  it("maps 'lost' → 'failed' (lossy)", () => {
    const out = toProtocolTask('s1', bashTask('t1', 'lost'));
    expect(out.status).toBe('failed');
  });

  it("maps 'agent' kind → 'subagent'", () => {
    const info: BackgroundTaskInfo = {
      taskId: 't_a',
      kind: 'agent',
      description: 'sub',
      status: 'running',
      startedAt: 0,
      endedAt: null,
    };
    expect(toProtocolTask('s', info).kind).toBe('subagent');
  });

  it("maps 'question' kind → 'tool'", () => {
    const info: BackgroundTaskInfo = {
      taskId: 't_q',
      kind: 'question',
      description: 'q',
      status: 'running',
      startedAt: 0,
      endedAt: null,
      questionCount: 1,
    };
    expect(toProtocolTask('s', info).kind).toBe('tool');
  });
});

// --- Service impl ---------------------------------------------------------

describe('TaskService.list', () => {
  it('throws SessionNotFoundError on unknown session', async () => {
    const svc = new TaskService(makeBridge(fresh()));
    await expect(svc.list('unknown', {})).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it('returns adapted tasks for the session', async () => {
    const state = fresh();
    state.sessions.push(session('s1'));
    state.tasksBySession.set('s1', [bashTask('t1', 'running'), bashTask('t2', 'completed', 1_001_000)]);
    const svc = new TaskService(makeBridge(state));
    const out = await svc.list('s1', {});
    expect(out).toHaveLength(2);
    expect(out[0]!.status).toBe('running');
    expect(out[1]!.status).toBe('completed');
  });

  it('filters by status when query.status is set', async () => {
    const state = fresh();
    state.sessions.push(session('s1'));
    state.tasksBySession.set('s1', [
      bashTask('t1', 'running'),
      bashTask('t2', 'completed', 1_001_000),
      bashTask('t3', 'killed', 1_002_000), // → 'cancelled'
    ]);
    const svc = new TaskService(makeBridge(state));
    expect((await svc.list('s1', { status: 'running' })).map((t) => t.id)).toEqual(['t1']);
    expect((await svc.list('s1', { status: 'cancelled' })).map((t) => t.id)).toEqual(['t3']);
  });
});

describe('TaskService.get', () => {
  it('throws TaskNotFoundError for unknown id', async () => {
    const state = fresh();
    state.sessions.push(session('s1'));
    state.tasksBySession.set('s1', []);
    const svc = new TaskService(makeBridge(state));
    await expect(svc.get('s1', 'nope')).rejects.toBeInstanceOf(TaskNotFoundError);
  });

  it('returns the adapted task by id', async () => {
    const state = fresh();
    state.sessions.push(session('s1'));
    state.tasksBySession.set('s1', [bashTask('t1', 'running')]);
    const svc = new TaskService(makeBridge(state));
    const task = await svc.get('s1', 't1');
    expect(task.id).toBe('t1');
  });

  it('includes output preview when withOutput is true', async () => {
    const state = fresh();
    state.sessions.push(session('s1'));
    state.tasksBySession.set('s1', [bashTask('t1', 'running')]);
    state.outputByTaskId.set('t1', 'hello\nworld');
    const svc = new TaskService(makeBridge(state));
    const task = await svc.get('s1', 't1', { withOutput: true });
    expect(task.output_preview).toBe('hello\nworld');
    expect(task.output_bytes).toBeGreaterThan(0);
  });

  it('omits output preview when withOutput is false or omitted', async () => {
    const state = fresh();
    state.sessions.push(session('s1'));
    state.tasksBySession.set('s1', [bashTask('t1', 'running')]);
    state.outputByTaskId.set('t1', 'hello\nworld');
    const svc = new TaskService(makeBridge(state));
    const task = await svc.get('s1', 't1');
    expect(task.output_preview).toBeUndefined();
    expect(task.output_bytes).toBeUndefined();
  });

  it('respects outputBytes for tail', async () => {
    const state = fresh();
    state.sessions.push(session('s1'));
    state.tasksBySession.set('s1', [bashTask('t1', 'running')]);
    state.outputByTaskId.set('t1', '0123456789');
    const svc = new TaskService(makeBridge(state));
    const task = await svc.get('s1', 't1', { withOutput: true, outputBytes: 4 });
    expect(task.output_preview).toBe('6789');
  });

  it('survives missing output when withOutput is true', async () => {
    const state = fresh();
    state.sessions.push(session('s1'));
    state.tasksBySession.set('s1', [bashTask('t1', 'running')]);
    const svc = new TaskService(makeBridge(state));
    const task = await svc.get('s1', 't1', { withOutput: true });
    expect(task.output_preview).toBeUndefined();
    expect(task.id).toBe('t1');
  });
});

describe('TaskService.cancel', () => {
  it('throws TaskNotFoundError for unknown id', async () => {
    const state = fresh();
    state.sessions.push(session('s1'));
    state.tasksBySession.set('s1', []);
    const svc = new TaskService(makeBridge(state));
    await expect(svc.cancel('s1', 'nope')).rejects.toBeInstanceOf(TaskNotFoundError);
  });

  it('throws TaskAlreadyFinishedError when status is completed', async () => {
    const state = fresh();
    state.sessions.push(session('s1'));
    state.tasksBySession.set('s1', [bashTask('t1', 'completed', 1_001_000)]);
    const svc = new TaskService(makeBridge(state));
    await expect(svc.cancel('s1', 't1')).rejects.toBeInstanceOf(TaskAlreadyFinishedError);
  });

  it('throws TaskAlreadyFinishedError when status is failed (terminal)', async () => {
    const state = fresh();
    state.sessions.push(session('s1'));
    state.tasksBySession.set('s1', [bashTask('t1', 'failed', 1_001_000)]);
    const svc = new TaskService(makeBridge(state));
    await expect(svc.cancel('s1', 't1')).rejects.toBeInstanceOf(TaskAlreadyFinishedError);
  });

  it('throws TaskAlreadyFinishedError when agent-core status is killed (→ cancelled)', async () => {
    const state = fresh();
    state.sessions.push(session('s1'));
    state.tasksBySession.set('s1', [bashTask('t1', 'killed', 1_001_000)]);
    const svc = new TaskService(makeBridge(state));
    await expect(svc.cancel('s1', 't1')).rejects.toBeInstanceOf(TaskAlreadyFinishedError);
  });

  it('calls bridge.rpc.stopBackground({taskId}) for a running task', async () => {
    const state = fresh();
    state.sessions.push(session('s1'));
    state.tasksBySession.set('s1', [bashTask('t1', 'running')]);
    const svc = new TaskService(makeBridge(state));
    const result = await svc.cancel('s1', 't1');
    expect(result).toEqual({ cancelled: true });
    expect(state.stopCalls).toHaveLength(1);
    expect(state.stopCalls[0]!.taskId).toBe('t1');
    expect(state.stopCalls[0]!.sessionId).toBe('s1');
  });
});
