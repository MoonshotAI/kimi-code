import { afterEach, describe, expect, it, vi } from 'vitest';

import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { AgentTask } from '#/features/task/taskAgentRuntime';
import { ISessionTaskView } from '#/features/task/sessionTaskView';
import type { TaskExecution } from '#/features/task/types';
import { ErrorCodes } from '#/errors';

import { createTestAgent, type TestAgentContext } from '../../harness';

function fakeProcessTask(description = 'fake process task'): TaskExecution {
  return {
    idPrefix: 'test',
    kind: 'process',
    description,
    start: () => {},
    toInfo: (base) => ({ ...base, kind: 'process', command: 'echo', pid: 0, exitCode: null }),
  };
}

function outputtingTask(output: string): TaskExecution {
  return {
    ...fakeProcessTask(),
    start: async (sink) => {
      sink.appendOutput(output);
      await sink.settle({ status: 'completed' });
    },
  };
}

describe('ISessionTaskView', () => {
  const contexts: TestAgentContext[] = [];

  afterEach(async () => {
    for (const ctx of contexts.splice(0)) await ctx.dispose();
  });

  function harness(): TestAgentContext {
    const ctx = createTestAgent();
    contexts.push(ctx);
    return ctx;
  }

  it('list aggregates tasks from every agent with owner ids', async () => {
    const ctx = harness();
    const manager = ctx.get(IAgentLifecycleService);
    const other = await manager.create({ agentId: 'agent-1' });
    const mainTask = manager.resolve(ctx.agentContext, AgentTask).registerTask(fakeProcessTask());
    const otherTask = manager.resolve(other, AgentTask).registerTask(fakeProcessTask());

    const view = ctx.get(ISessionTaskView);
    const rows = view.list(false);
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual({ ownerAgentId: 'main', info: expect.objectContaining({ taskId: mainTask }) });
    expect(rows).toContainEqual({ ownerAgentId: 'agent-1', info: expect.objectContaining({ taskId: otherTask }) });
  });

  it('list applies the limit across the aggregated view', async () => {
    const ctx = harness();
    const manager = ctx.get(IAgentLifecycleService);
    const other = await manager.create({ agentId: 'agent-1' });
    manager.resolve(ctx.agentContext, AgentTask).registerTask(fakeProcessTask());
    manager.resolve(other, AgentTask).registerTask(fakeProcessTask());

    expect(ctx.get(ISessionTaskView).list(false, 1)).toHaveLength(1);
  });

  it('get routes by owner and returns the owner id', async () => {
    const ctx = harness();
    const manager = ctx.get(IAgentLifecycleService);
    const other = await manager.create({ agentId: 'agent-1' });
    manager.resolve(ctx.agentContext, AgentTask).registerTask(fakeProcessTask());
    const otherTask = manager.resolve(other, AgentTask).registerTask(fakeProcessTask());

    const entry = ctx.get(ISessionTaskView).get(otherTask);
    expect(entry?.ownerAgentId).toBe('agent-1');
    expect(entry?.info.taskId).toBe(otherTask);
  });

  it('get returns undefined for an unknown task id', () => {
    const ctx = harness();
    expect(ctx.get(ISessionTaskView).get('bash-missing0')).toBeUndefined();
  });

  it('get throws task.id_conflict when two agents own the same id', async () => {
    const ctx = harness();
    const manager = ctx.get(IAgentLifecycleService);
    const other = await manager.create({ agentId: 'agent-1' });
    manager.resolve(ctx.agentContext, AgentTask).registerTask(fakeProcessTask(), { taskId: 'bash-abcd1234' });
    manager.resolve(other, AgentTask).registerTask(fakeProcessTask(), { taskId: 'bash-abcd1234' });

    expect(() => ctx.get(ISessionTaskView).get('bash-abcd1234')).toThrowError(
      expect.objectContaining({ code: ErrorCodes.TASK_ID_CONFLICT }),
    );
  });

  it('readOutput routes to the owning agent', async () => {
    const ctx = harness();
    const manager = ctx.get(IAgentLifecycleService);
    const other = await manager.create({ agentId: 'agent-1' });
    const taskId = manager.resolve(other, AgentTask).registerTask(outputtingTask('child output\n'));
    await manager.resolve(other, AgentTask).wait(taskId, 1000);

    await expect(ctx.get(ISessionTaskView).readOutput(taskId)).resolves.toContain('child output');
  });

  it('readOutput returns an empty string for an unknown task id', async () => {
    const ctx = harness();
    await expect(ctx.get(ISessionTaskView).readOutput('bash-missing0')).resolves.toBe('');
  });

  it('stop routes to the owning agent', async () => {
    const ctx = harness();
    const manager = ctx.get(IAgentLifecycleService);
    const other = await manager.create({ agentId: 'agent-1' });
    const mainTask = manager.resolve(ctx.agentContext, AgentTask).registerTask(fakeProcessTask());
    const otherTask = manager.resolve(other, AgentTask).registerTask(fakeProcessTask());

    const stopped = await ctx.get(ISessionTaskView).stop(otherTask, 'view stop');

    expect(stopped?.status).toBe('killed');
    expect(stopped?.stopReason).toBe('view stop');
    expect(manager.resolve(ctx.agentContext, AgentTask).getTask(mainTask)?.status).toBe('running');
  });

  it('stopByUser routes to the owning agent with a user-cancellation reason', async () => {
    const ctx = harness();
    const manager = ctx.get(IAgentLifecycleService);
    const other = await manager.create({ agentId: 'agent-1' });
    const otherTask = manager.resolve(other, AgentTask).registerTask(fakeProcessTask());

    const stopped = await ctx.get(ISessionTaskView).stopByUser(otherTask);

    expect(stopped?.status).toBe('killed');
    expect(manager.resolve(other, AgentTask).getTask(otherTask)?.status).toBe('killed');
  });

  it('does not create agents when listing or resolving owners', async () => {
    const ctx = harness();
    const manager = ctx.get(IAgentLifecycleService);
    const createSpy = vi.spyOn(manager, 'create');
    const other = await manager.create({ agentId: 'agent-1' });
    manager.resolve(other, AgentTask).registerTask(fakeProcessTask());
    createSpy.mockClear();

    const view = ctx.get(ISessionTaskView);
    view.list(false);
    view.list(true);
    expect(view.get('bash-missing0')).toBeUndefined();
    await view.readOutput('bash-missing0');

    expect(createSpy).not.toHaveBeenCalled();
    expect(manager.list().map((agent) => agent.agentId).toSorted()).toEqual(['agent-1', 'main']);
  });
});
