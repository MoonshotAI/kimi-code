import {
  IAgentLifecycleService,
  IAgentTaskService,
  IConfigService,
  type AgentTaskInfo,
  type IAgentScopeHandle,
  type ISessionScopeHandle,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { describe, expect, it } from 'vitest';

import { V2Session } from '../../../src/cli/v2/v2-session';

interface FakeTask {
  readonly taskId: string;
  /** ms until this task completes once `wait` is called on it. */
  readonly completesInMs: number;
  /** Optional task to spawn (append to the active list) when this task completes. */
  readonly spawnsOnComplete?: FakeTask;
  active: boolean;
}

class FakeTaskService {
  readonly suppressed: string[] = [];
  readonly waitCalls: Array<{ taskId: string; timeoutMs: number | undefined }> = [];

  constructor(private readonly tasks: FakeTask[]) {}

  list(activeOnly?: boolean): readonly AgentTaskInfo[] {
    return this.tasks
      .filter((task) => !activeOnly || task.active)
      .map((task) => ({ taskId: task.taskId, status: 'running' }) as unknown as AgentTaskInfo);
  }

  suppressTerminalNotification(taskId: string): Promise<void> {
    this.suppressed.push(taskId);
    return Promise.resolve();
  }

  wait(taskId: string, timeoutMs?: number): Promise<AgentTaskInfo | undefined> {
    this.waitCalls.push({ taskId, timeoutMs });
    const task = this.tasks.find((entry) => entry.taskId === taskId);
    const completesInMs = task?.completesInMs ?? 0;
    const completed =
      task !== undefined && completesInMs <= (timeoutMs ?? Number.POSITIVE_INFINITY);
    const waitMs = timeoutMs === undefined ? completesInMs : Math.min(completesInMs, timeoutMs);
    return new Promise((resolve) => {
      setTimeout(() => {
        if (completed && task !== undefined) {
          task.active = false;
          if (task.spawnsOnComplete !== undefined) this.tasks.push(task.spawnsOnComplete);
        }
        resolve({
          taskId,
          status: completed ? 'completed' : 'running',
        } as unknown as AgentTaskInfo);
      }, waitMs);
    });
  }
}

function fakeAccessor(map: Map<unknown, unknown>) {
  return { get: (token: unknown) => map.get(token) };
}

function buildSession(options: { ceilingS?: number; taskServices: FakeTaskService[] }): V2Session {
  const coreMap = new Map<unknown, unknown>([
    [
      IConfigService,
      {
        get: (section: string) =>
          section === 'task' && options.ceilingS !== undefined
            ? { printWaitCeilingS: options.ceilingS }
            : undefined,
      },
    ],
  ]);

  const agentHandles: IAgentScopeHandle[] = options.taskServices.map((service) => {
    const agentMap = new Map<unknown, unknown>([[IAgentTaskService, service]]);
    return { accessor: fakeAccessor(agentMap) } as unknown as IAgentScopeHandle;
  });

  const sessionMap = new Map<unknown, unknown>([
    [
      IAgentLifecycleService,
      {
        list: () => agentHandles,
      },
    ],
  ]);

  return new V2Session({
    core: { accessor: fakeAccessor(coreMap) } as unknown as Scope,
    session: { id: 'sess-1', accessor: fakeAccessor(sessionMap) } as unknown as ISessionScopeHandle,
    agent: { id: 'main', accessor: fakeAccessor(new Map()) } as unknown as IAgentScopeHandle,
  });
}

describe('V2Session.waitForBackgroundTasksOnPrint', () => {
  it('returns immediately when there are no active background tasks', async () => {
    const service = new FakeTaskService([]);
    const session = buildSession({ taskServices: [service] });

    await session.waitForBackgroundTasksOnPrint();

    expect(service.waitCalls).toHaveLength(0);
  });

  it('waits for a background task to complete and bounds the wait by the default ceiling, not 30s', async () => {
    const service = new FakeTaskService([{ taskId: 'a', completesInMs: 20, active: true }]);
    const session = buildSession({ taskServices: [service] });

    await session.waitForBackgroundTasksOnPrint();

    expect(service.waitCalls).toHaveLength(1);
    expect(service.waitCalls[0]?.taskId).toBe('a');
    // The old implementation hardcoded a 30s cap; the drain must use the 1h
    // default ceiling so long tasks are allowed to finish.
    expect(service.waitCalls[0]?.timeoutMs).toBeGreaterThan(30_000);
    expect(service.suppressed).toContain('a');
  });

  it('honors [task].print_wait_ceiling_s as the wait bound', async () => {
    const service = new FakeTaskService([
      { taskId: 'stuck', completesInMs: Number.POSITIVE_INFINITY, active: true },
    ]);
    const session = buildSession({ ceilingS: 1, taskServices: [service] });

    const startedAt = Date.now();
    await session.waitForBackgroundTasksOnPrint();
    const elapsed = Date.now() - startedAt;

    expect(service.waitCalls[0]?.timeoutMs).toBeLessThanOrEqual(1000);
    expect(service.waitCalls[0]?.timeoutMs).toBeGreaterThan(0);
    // Returns near the 1s ceiling, never hangs until the (infinite) task.
    expect(elapsed).toBeLessThan(5_000);
  });

  it('re-enumerates to drain tasks spawned by a completing task', async () => {
    const spawned: FakeTask = { taskId: 'b', completesInMs: 20, active: true };
    const service = new FakeTaskService([
      { taskId: 'a', completesInMs: 20, active: true, spawnsOnComplete: spawned },
    ]);
    const session = buildSession({ taskServices: [service] });

    await session.waitForBackgroundTasksOnPrint();

    const waitedIds = service.waitCalls.map((call) => call.taskId);
    expect(waitedIds).toContain('a');
    expect(waitedIds).toContain('b');
    expect(service.suppressed).toEqual(expect.arrayContaining(['a', 'b']));
  });
});
