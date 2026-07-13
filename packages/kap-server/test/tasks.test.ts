import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IEventBus,
  IAgentLifecycleService,
  IAgentProfileService,
  IAgentTaskService,
  ISessionLifecycleService,
  ISessionSwarmService,
  IModelResolver,
  type AgentTask,
  type DomainEvent,
} from '@moonshot-ai/agent-core-v2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: unknown;
}

interface TaskWire {
  id: string;
  session_id: string;
  kind: string;
  description: string;
  status: string;
  command?: string;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  output_preview?: string;
  output_bytes?: number;
}

interface ListWire {
  items: TaskWire[];
}

describe('server-v2 /api/v1/sessions/{sid}/tasks', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-tasks-'));
    // Seed a stub ISessionModelResolver so the agent scope can instantiate if a
    // transitive service needs it; IAgentTaskService itself does not.
    const modelResolver: IModelResolver = {
      _serviceBrand: undefined,
      resolve: () => {
        throw new Error('modelResolver.resolve not exercised in this test');
      },
      findByName: () => [],
    };
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      seeds: [[IModelResolver, modelResolver]],
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 } as never);
      home = undefined;
    }
  });

  async function getJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function postJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function createSession(): Promise<string> {
    const res = await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd: home as string } }),
    } as never);
    const body = (await res.json()) as Envelope<{ id: string }>;
    expect(body.code).toBe(0);
    return body.data.id;
  }

  function cancelTask<T = { cancelled: boolean }>(
    sessionId: string,
    taskOrAgentId: string,
  ): Promise<{ status: number; body: Envelope<T> }> {
    return postJson<T>(
      `/api/v1/sessions/${sessionId}/tasks/${encodeURIComponent(taskOrAgentId)}:cancel`,
    );
  }

  // The main agent scope is not created automatically on session creation
  // (server-v2 gap G10); create it here, then register fake tasks
  // directly into its IAgentTaskService to bypass the tool loop.
  async function mainAgentTasks(sessionId: string): Promise<IAgentTaskService> {
    const session = server!.core.accessor.get(ISessionLifecycleService).get(sessionId);
    if (session === undefined) throw new Error(`session ${sessionId} not found`);
    const agent =
      session.accessor.get(IAgentLifecycleService).getHandle('main') ??
      (await session.accessor.get(IAgentLifecycleService).create({ agentId: 'main' }));
    return agent.accessor.get(IAgentTaskService);
  }

  async function sessionSwarm(sessionId: string): Promise<ISessionSwarmService> {
    await mainAgentTasks(sessionId);
    const session = server!.core.accessor.get(ISessionLifecycleService).get(sessionId);
    if (session === undefined) throw new Error(`session ${sessionId} not found`);
    return session.accessor.get(ISessionSwarmService);
  }

  // Let the `registerTask` microtask run `start` (which appends output) before
  // the next request.
  async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  function fakeTask(
    kind: 'process' | 'agent' | 'question',
    output?: string,
    agentId = 'sub-1',
  ): AgentTask {
    return {
      idPrefix: 'test',
      kind,
      description: `fake ${kind} task`,
      start: (sink) => {
        if (output !== undefined) sink.appendOutput(output);
      },
      toInfo: (base) => {
        switch (kind) {
          case 'process':
            return { ...base, kind: 'process', command: 'echo hi', pid: 0, exitCode: null };
          case 'agent':
            return { ...base, kind: 'agent', agentId, subagentType: 'explore' };
          case 'question':
            return { ...base, kind: 'question', questionCount: 1 };
        }
      },
    };
  }

  function completedAgentTask(agentId: string): AgentTask {
    return {
      ...fakeTask('agent', undefined, agentId),
      start: async (sink) => {
        await sink.settle({ status: 'completed' });
      },
    };
  }

  it('returns an empty list when the session has no main agent (gap G10)', async () => {
    const id = await createSession();
    const { body } = await getJson<ListWire>(`/api/v1/sessions/${id}/tasks`);
    expect(body.code).toBe(0);
    expect(body.data.items).toEqual([]);
  });

  it('returns an empty list when the main agent has no tasks yet', async () => {
    const id = await createSession();
    await mainAgentTasks(id);
    const { body } = await getJson<ListWire>(`/api/v1/sessions/${id}/tasks`);
    expect(body.code).toBe(0);
    expect(body.data.items).toEqual([]);
  });

  it('lists registered tasks with mapped kind/status and wire-shaped fields', async () => {
    const id = await createSession();
    const tasks = await mainAgentTasks(id);
    const processId = tasks.registerTask(fakeTask('process'));
    const agentId = tasks.registerTask(fakeTask('agent'));
    const questionId = tasks.registerTask(fakeTask('question'));
    await flush();

    const { body } = await getJson<ListWire>(`/api/v1/sessions/${id}/tasks`);
    expect(body.code).toBe(0);
    const byId = new Map(body.data.items.map((t) => [t.id, t]));
    expect(byId.size).toBe(3);

    const process = byId.get(processId);
    expect(process).toMatchObject({
      id: processId,
      session_id: id,
      kind: 'bash', // process → bash
      status: 'running',
      description: 'fake process task',
      command: 'echo hi', // only process/bash tasks expose command
    });
    expect(typeof process?.created_at).toBe('string');

    expect(byId.get(agentId)).toMatchObject({
      id: agentId,
      session_id: id,
      kind: 'subagent', // agent → subagent
      status: 'running',
    });
    expect(byId.get(agentId)?.command).toBeUndefined();

    expect(byId.get(questionId)).toMatchObject({
      id: questionId,
      session_id: id,
      kind: 'tool', // question → tool
      status: 'running',
    });
  });

  it('filters the list by wire status', async () => {
    const id = await createSession();
    const tasks = await mainAgentTasks(id);
    tasks.registerTask(fakeTask('process'));
    await flush();

    const running = await getJson<ListWire>(`/api/v1/sessions/${id}/tasks?status=running`);
    expect(running.body.code).toBe(0);
    expect(running.body.data.items).toHaveLength(1);
    expect(running.body.data.items[0]?.status).toBe('running');

    const completed = await getJson<ListWire>(`/api/v1/sessions/${id}/tasks?status=completed`);
    expect(completed.body.code).toBe(0);
    expect(completed.body.data.items).toEqual([]);
  });

  it('gets a single task by id and 40406 for an unknown task', async () => {
    const id = await createSession();
    const tasks = await mainAgentTasks(id);
    const taskId = tasks.registerTask(fakeTask('process'));
    await flush();

    const got = await getJson<TaskWire>(`/api/v1/sessions/${id}/tasks/${taskId}`);
    expect(got.body.code).toBe(0);
    expect(got.body.data).toMatchObject({ id: taskId, session_id: id, kind: 'bash' });

    const missing = await getJson<null>(`/api/v1/sessions/${id}/tasks/nope`);
    expect(missing.body.code).toBe(40406);
  });

  it('cancels an Agent task by its stable Agent id', async () => {
    const id = await createSession();
    const tasks = await mainAgentTasks(id);
    const taskId = tasks.registerTask(fakeTask('agent', undefined, 'agent-ui'));
    await flush();

    const cancelled = await cancelTask(id, 'agent-ui');
    expect(cancelled.body).toMatchObject({ code: 0, data: { cancelled: true } });
    expect(tasks.getTask(taskId)).toMatchObject({ status: 'killed' });
  });

  it('reports an Agent task as already finished when its alias is cancelled twice', async () => {
    const id = await createSession();
    const tasks = await mainAgentTasks(id);
    tasks.registerTask(fakeTask('agent', undefined, 'agent-ui'));
    await flush();

    await cancelTask(id, 'agent-ui');
    const repeated = await cancelTask(id, 'agent-ui');
    expect(repeated.body).toMatchObject({
      code: 40904,
      data: { cancelled: false },
      details: { current_status: 'cancelled' },
    });
  });

  it('includes output_preview / output_bytes when with_output is set', async () => {
    const id = await createSession();
    const tasks = await mainAgentTasks(id);
    const taskId = tasks.registerTask(fakeTask('process', 'hello world'));
    await flush();

    const got = await getJson<TaskWire>(
      `/api/v1/sessions/${id}/tasks/${taskId}?with_output=true`,
    );
    expect(got.body.code).toBe(0);
    expect(got.body.data.output_preview).toBe('hello world');
    expect(got.body.data.output_bytes).toBe(Buffer.byteLength('hello world', 'utf-8'));

    // Without with_output the metadata is returned without output fields.
    const plain = await getJson<TaskWire>(`/api/v1/sessions/${id}/tasks/${taskId}`);
    expect(plain.body.code).toBe(0);
    expect(plain.body.data.output_preview).toBeUndefined();
    expect(plain.body.data.output_bytes).toBeUndefined();
  });

  it('cancels a running task and reports 40904 on a second cancel', async () => {
    const id = await createSession();
    const tasks = await mainAgentTasks(id);
    const taskId = tasks.registerTask(fakeTask('process'));
    await flush();

    const cancelled = await cancelTask(id, taskId);
    expect(cancelled.body.code).toBe(0);
    expect(cancelled.body.data).toEqual({ cancelled: true });

    // The task is now terminal (killed → cancelled); a second cancel is a
    // conflict with the idempotent envelope shape.
    const again = await cancelTask(id, taskId);
    expect(again.body.code).toBe(40904);
    expect(again.body.data).toEqual({ cancelled: false });
    expect(again.body.details).toEqual({ current_status: 'cancelled' });
  });

  it('cancelling an unknown task returns 40406', async () => {
    const id = await createSession();
    await mainAgentTasks(id);
    const { body } = await cancelTask<null>(id, 'nope');
    expect(body.code).toBe(40406);
  });

  it('cancels a swarm member by Agent id and keeps repeated stop idempotent', async () => {
    const id = await createSession();
    const swarm = await sessionSwarm(id);
    const stopAgent = vi
      .spyOn(swarm, 'stopAgent')
      .mockReturnValueOnce({
        kind: 'stopping',
        agentId: 'agent-swarm',
      })
      .mockReturnValueOnce({
        kind: 'already_terminal',
        agentId: 'agent-swarm',
        status: 'aborted',
      });

    const cancelled = await cancelTask(id, 'agent-swarm');
    expect(cancelled.body).toMatchObject({ code: 0, data: { cancelled: true } });
    expect(stopAgent).toHaveBeenLastCalledWith('agent-swarm');

    const again = await cancelTask(id, 'agent-swarm');
    expect(again.body).toMatchObject({
      code: 40904,
      data: { cancelled: false },
      details: { current_status: 'cancelled' },
    });
  });

  it('publishes one cancellation when REST stops a non-main swarm during its start hook', async () => {
    const id = await createSession();
    const swarm = await sessionSwarm(id);
    const session = server!.core.accessor.get(ISessionLifecycleService).get(id);
    if (session === undefined) throw new Error(`session ${id} not found`);
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    const caller = await lifecycle.create({ agentId: 'agent-caller' });
    caller.accessor.get(IAgentProfileService).update({ modelAlias: 'test-model' });
    await lifecycle.create({
      agentId: 'agent-owned-child',
      labels: { parentAgentId: caller.id },
    });

    let enterHook: () => void = () => {};
    const hookEntered = new Promise<void>((resolve) => {
      enterHook = resolve;
    });
    let releaseHook: () => void = () => {};
    const hookReleased = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    const hookRegistration = lifecycle.hooks.onWillStartAgentTask.register(
      'tasks-test-deferred-start',
      async (_context, next) => {
        enterHook();
        await hookReleased;
        await next();
      },
    );
    const failures: Array<DomainEvent<'subagent.failed'>> = [];
    const eventRegistration = caller.accessor
      .get(IEventBus)
      .subscribe('subagent.failed', (event) => {
        if (event.subagentId === 'agent-owned-child') failures.push(event);
      });

    let rejectCompletion: (reason?: unknown) => void = () => {};
    const completion = new Promise<{ summary: string }>((_resolve, reject) => {
      rejectCompletion = reject;
    });
    let runSignal: AbortSignal | undefined;
    const runAgent = vi.spyOn(lifecycle, 'run').mockImplementation(
      async (agentId, _request, options) => {
        runSignal = options.signal;
        options.signal.addEventListener(
          'abort',
          () => {
            rejectCompletion(options.signal.reason);
          },
          { once: true },
        );
        options.onReady?.();
        return { agentId, turn: {} as never, completion };
      },
    );
    const running = swarm.run({
      callerAgentId: caller.id,
      tasks: [
        {
          kind: 'resume',
          data: undefined,
          profileName: 'subagent',
          parentToolCallId: 'call_non_main_swarm',
          prompt: 'Continue',
          description: 'Continue child',
          runInBackground: false,
          resumeAgentId: 'agent-owned-child',
        },
      ],
    });
    await vi.waitFor(() => {
      expect(runAgent).toHaveBeenCalledOnce();
    });
    await hookEntered;

    const cancelled = await cancelTask(id, 'agent-owned-child');

    expect(cancelled.body).toMatchObject({ code: 0, data: { cancelled: true } });
    expect(runSignal?.aborted).toBe(true);
    expect(failures).toEqual([]);
    releaseHook();
    await expect(running).resolves.toMatchObject([
      { agentId: 'agent-owned-child', status: 'aborted' },
    ]);
    expect(failures).toEqual([
      expect.objectContaining({
        subagentId: 'agent-owned-child',
        cancelled: true,
      }),
    ]);
    const repeated = await cancelTask(id, 'agent-owned-child');
    expect(repeated.body).toMatchObject({
      code: 40904,
      data: { cancelled: false },
      details: { current_status: 'cancelled' },
    });
    expect(failures).toHaveLength(1);
    eventRegistration.dispose();
    hookRegistration.dispose();
  });

  it('keeps resumed swarm cancellation authoritative over terminal task history', async () => {
    const id = await createSession();
    const tasks = await mainAgentTasks(id);
    const historicalTaskId = tasks.registerTask(completedAgentTask('agent-resumed'));
    expect(await tasks.wait(historicalTaskId)).toMatchObject({ status: 'completed' });
    expect(tasks.getAgentTask('agent-resumed')).toMatchObject({
      taskId: historicalTaskId,
      status: 'completed',
    });

    const swarm = await sessionSwarm(id);
    const stopAgent = vi.spyOn(swarm, 'stopAgent').mockReturnValue({
      kind: 'stopping',
      agentId: 'agent-resumed',
    });

    const cancelled = await cancelTask(id, 'agent-resumed');

    expect(cancelled.body).toMatchObject({ code: 0, data: { cancelled: true } });
    expect(stopAgent).toHaveBeenCalledWith('agent-resumed');
  });

  it('reports an exact terminal task id before a matching active swarm member', async () => {
    const id = await createSession();
    const tasks = await mainAgentTasks(id);
    const historicalTaskId = tasks.registerTask(completedAgentTask('agent-history'));
    await tasks.wait(historicalTaskId);

    const swarm = await sessionSwarm(id);
    const stopAgent = vi.spyOn(swarm, 'stopAgent').mockReturnValue({
      kind: 'stopping',
      agentId: historicalTaskId,
    });

    const cancelled = await cancelTask(id, historicalTaskId);

    expect(cancelled.body).toMatchObject({
      code: 40904,
      data: { cancelled: false },
      details: { current_status: 'completed' },
    });
    expect(stopAgent).not.toHaveBeenCalled();
  });

  it('rejects a bare POST without the :cancel suffix (40001)', async () => {
    const id = await createSession();
    const tasks = await mainAgentTasks(id);
    const taskId = tasks.registerTask(fakeTask('process'));
    await flush();

    const { body } = await postJson<null>(`/api/v1/sessions/${id}/tasks/${taskId}`);
    expect(body.code).toBe(40001);
  });

  it('returns 40401 for an unknown session on all three endpoints', async () => {
    const list = await getJson<null>('/api/v1/sessions/nope/tasks');
    expect(list.body.code).toBe(40401);

    const got = await getJson<null>('/api/v1/sessions/nope/tasks/tid');
    expect(got.body.code).toBe(40401);

    const cancelled = await cancelTask<null>('nope', 'tid');
    expect(cancelled.body.code).toBe(40401);
  });
});
