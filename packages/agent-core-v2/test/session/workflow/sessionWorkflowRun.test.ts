import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ServiceIdentifier, ServicesAccessor } from '#/_base/di/instantiation';
import { DisposableStore } from '#/_base/di/lifecycle';
import { LifecycleScope, type IAgentScopeHandle } from '#/_base/di/scope';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { isError2 } from '#/_base/errors/errors';
import { ILogService } from '#/_base/log/log';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentProfileService, type ProfileData } from '#/agent/profile/profile';
import { IAgentTaskService } from '#/agent/task/task';
import type { AgentTask, AgentTaskSettlement, AgentTaskSink } from '#/agent/task/types';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IConfigService } from '#/app/config/config';
import { IEventBus, type DomainEvent } from '#/app/event/eventBus';
import { IFlagService } from '#/app/flag/flag';
import { DEFAULT_WORKFLOWS_CONFIG, WORKFLOWS_SECTION } from '#/app/workflow/configSection';
import { WorkflowErrors } from '#/app/workflow/errors';
import type { WorkflowDefinition } from '#/app/workflow/runtime/types';
import { IWorkflowCatalogService } from '#/app/workflow/workflowCatalog';
import { createHooks } from '#/hooks';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import { IAgentLifecycleService, type CreateAgentOptions } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionProcessRunner } from '#/session/process/processRunner';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import {
  type AgentRunHandle,
  type AgentRunRequest,
  type AgentTaskHooks,
  ISessionSubagentService,
  type RunAgentOptions,
} from '#/session/subagent/subagent';
import {
  IWorkflowRunService,
  type WorkflowRunRecord,
} from '#/session/workflow/sessionWorkflowRun';
import { WorkflowRunService } from '#/session/workflow/sessionWorkflowRunService';

import { stubLog } from '../../_base/log/stubs';

const META = `export const meta = {
  name: 'test-flow',
  description: 'Test workflow.',
  phases: [{ title: 'One' }, { title: 'Two' }],
};`;

function inlineScript(body: string): string {
  return `${META}\n${body}\n`;
}

function testDefinition(script: string): WorkflowDefinition {
  return {
    meta: {
      name: 'test-flow',
      description: 'Test workflow.',
      phases: [{ title: 'One' }, { title: 'Two' }],
    },
    script,
    path: '',
    source: 'project',
  };
}

interface CapturedTask {
  task: AgentTask;
  options?: { detached?: boolean; timeoutMs?: number };
  controller: AbortController;
  output: string[];
  settlement?: AgentTaskSettlement;
  started: Promise<void>;
}

class TestAgentTaskService {
  readonly captured: CapturedTask[] = [];

  registerTask(task: AgentTask, options?: { detached?: boolean; timeoutMs?: number }): string {
    const controller = new AbortController();
    const captured: CapturedTask = {
      task,
      options,
      controller,
      output: [],
      started: Promise.resolve(),
    };
    const sink: AgentTaskSink = {
      signal: controller.signal,
      appendOutput: (chunk) => captured.output.push(chunk),
      settle: (settlement) => {
        captured.settlement = settlement;
        return Promise.resolve(true);
      },
    };
    // Mimic the production task service: task.start is deferred to a microtask
    // so the run service's synchronous `workflow.run.started` publish lands first.
    captured.started = Promise.resolve()
      .then(() => task.start(sink))
      .then(() => undefined);
    this.captured.push(captured);
    return `task-${String(this.captured.length)}`;
  }

  stop(taskId: string, _reason?: string): Promise<undefined> {
    const index = Number(taskId.split('-')[1]) - 1;
    this.captured[index]?.controller.abort();
    return Promise.resolve(undefined);
  }
}

function makeAccessor(map: ReadonlyMap<ServiceIdentifier<unknown>, unknown>): ServicesAccessor {
  return {
    get: <T>(id: ServiceIdentifier<T>): T => map.get(id as ServiceIdentifier<unknown>) as T,
  };
}

function makeHandle(id: string, services: Map<ServiceIdentifier<unknown>, unknown>): IAgentScopeHandle {
  return {
    id,
    kind: LifecycleScope.Agent,
    accessor: makeAccessor(services),
    dispose: () => {},
  };
}

const CALLER_PROFILE: ProfileData = {
  cwd: '/tmp/work',
  modelAlias: 'test-model',
  thinkingLevel: 'high',
} as ProfileData;

describe('WorkflowRunService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let taskService: TestAgentTaskService;
  let events: DomainEvent[];
  let subagentRuns: { agentId: string; request: AgentRunRequest }[];
  let subagentCompletion: (opts: RunAgentOptions) => Promise<{ summary: string }>;

  beforeEach(() => {
    disposables = new DisposableStore();
    taskService = new TestAgentTaskService();
    events = [];
    subagentRuns = [];
    subagentCompletion = () => Promise.resolve({ summary: 'agent answer' });

    const eventBus = {
      publish: (event: DomainEvent) => events.push(event),
      subscribe: () => ({ dispose: () => {} }),
    };
    const permissionMode = { mode: 'manual' as const, setMode: () => {} };
    const userTools = { inheritUserTools: () => {} };
    const callerServices = new Map<ServiceIdentifier<unknown>, unknown>([
      [IAgentTaskService as ServiceIdentifier<unknown>, taskService],
      [IAgentProfileService as ServiceIdentifier<unknown>, { data: () => CALLER_PROFILE }],
      [IAgentPermissionModeService as ServiceIdentifier<unknown>, permissionMode],
      [IAgentUserToolService as ServiceIdentifier<unknown>, userTools],
      [IEventBus as ServiceIdentifier<unknown>, eventBus],
    ]);

    const lifecycle = {
      get: (agentId: string): IAgentScopeHandle | undefined =>
        agentId === 'main' ? callerHandle : childHandles.get(agentId),
      create: (opts?: CreateAgentOptions): Promise<IAgentScopeHandle> => {
        const id = `child-${String(childHandles.size + 1)}`;
        const child = makeHandle(
          id,
          new Map<ServiceIdentifier<unknown>, unknown>([
            [IAgentPermissionModeService as ServiceIdentifier<unknown>, { setMode: () => {} }],
            [IAgentUserToolService as ServiceIdentifier<unknown>, { inheritUserTools: () => {} }],
          ]),
        );
        childHandles.set(id, child);
        return Promise.resolve(child);
      },
    };
    const childHandles = new Map<string, IAgentScopeHandle>();
    const callerHandle = makeHandle('main', callerServices);
    callerServices.set(IAgentLifecycleService as ServiceIdentifier<unknown>, lifecycle);

    const subagents = {
      hooks: createHooks<AgentTaskHooks, keyof AgentTaskHooks>(['onWillStartAgentTask']),
      run: (
        agentId: string,
        request: AgentRunRequest,
        opts: RunAgentOptions,
      ): Promise<AgentRunHandle> => {
        subagentRuns.push({ agentId, request });
        const handle: AgentRunHandle = {
          agentId,
          turn: undefined as unknown as AgentRunHandle['turn'],
          completion: subagentCompletion(opts),
        };
        return Promise.resolve(handle);
      },
      notifyAgentTaskStopped: () => {},
    };

    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(ILogService, stubLog());
        reg.definePartialInstance(IWorkflowCatalogService, {
          ready: Promise.resolve(),
          get: (name: string) =>
            name === 'test-flow' ? testDefinition(inlineScript(`return 'catalog-result';`)) : undefined,
        });
        reg.defineInstance(IAgentLifecycleService, lifecycle as unknown as IAgentLifecycleService);
        reg.defineInstance(ISessionSubagentService, subagents as unknown as ISessionSubagentService);
        reg.definePartialInstance(ISessionAgentProfileCatalog, {
          ready: Promise.resolve(),
          get: (name: string) => ({ name }) as AgentProfile,
        });
        reg.defineInstance(
          ISessionContext,
          makeSessionContext({
            sessionId: 'session-1',
            workspaceId: 'ws-1',
            sessionDir: '/tmp/session-1',
            sessionScope: 'sessions/ws-1/session-1',
            cwd: '/tmp/work',
          }),
        );
        reg.definePartialInstance(ISessionProcessRunner, {});
        reg.definePartialInstance(IConfigService, {
          get: <T = unknown>(domain: string): T =>
            (domain === WORKFLOWS_SECTION ? DEFAULT_WORKFLOWS_CONFIG : undefined) as T,
        });
        reg.definePartialInstance(IFlagService, { enabled: () => false });
        reg.definePartialInstance(IModelCatalog, { get: () => ({}) as unknown as Model });
        reg.define(IWorkflowRunService, WorkflowRunService);
      },
    });
  });
  afterEach(() => disposables.dispose());

  it('starts a run by catalog name and returns runId/taskId immediately', async () => {
    const runs = ix.get(IWorkflowRunService);
    const { runId, taskId } = await runs.start({
      name: 'test-flow',
      args: 'topic',
      callerAgentId: 'main',
    });

    expect(runId).toMatch(/^wfrun-/);
    expect(taskId).toBe('task-1');
    const record = runs.get(runId) as WorkflowRunRecord;
    expect(record.workflowName).toBe('test-flow');
    expect(record.source).toBe('project');
    expect(record.callerAgentId).toBe('main');
    expect(taskService.captured[0]?.options).toEqual({ detached: true, timeoutMs: 0 });

    await taskService.captured[0]!.started;
    expect(record.status).toBe('completed');
    expect(JSON.parse(record.resultJson!)).toBe('catalog-result');
    expect(taskService.captured[0]?.settlement).toEqual({ status: 'completed' });
    expect(events.map((event) => event.type)).toEqual([
      'workflow.run.started',
      'workflow.run.completed',
    ]);
  });

  it('runs an inline script with phases, logs and agent calls, emitting events in order', async () => {
    const runs = ix.get(IWorkflowRunService);
    const { runId } = await runs.start({
      script: inlineScript(`
        phase('One');
        log('begin');
        const answer = await agent('question', { label: 'q1' });
        phase('Two');
        return { answer, args };
      `),
      args: 'topic-x',
      callerAgentId: 'main',
    });

    await taskService.captured[0]!.started;
    const record = runs.get(runId)!;
    expect(record.status).toBe('completed');
    expect(JSON.parse(record.resultJson!)).toEqual({ answer: 'agent answer', args: 'topic-x' });
    expect(record.agentCalls).toBe(1);
    expect(record.phase).toBe('Two');

    expect(subagentRuns).toHaveLength(1);
    const workflowEvents = events
      .map((event) => event.type)
      .filter((type) => type.startsWith('workflow.'));
    expect(workflowEvents).toEqual([
      'workflow.run.started',
      'workflow.run.phase',
      'workflow.run.log',
      'workflow.run.agent_call',
      'workflow.run.agent_call',
      'workflow.run.phase',
      'workflow.run.completed',
    ]);
    expect(events.some((event) => event.type === 'subagent.spawned')).toBe(true);
    const completed = workflowEvents.at(-1);
    expect(completed).toBe('workflow.run.completed');
    expect(events.at(-1)).toMatchObject({ type: 'workflow.run.completed', status: 'completed' });
  });

  it('throws workflow.not_found for an unknown catalog name', async () => {
    const runs = ix.get(IWorkflowRunService);
    const failure = await runs
      .start({ name: 'missing', args: '', callerAgentId: 'main' })
      .catch((error: unknown) => error);
    expect(isError2(failure)).toBe(true);
    if (isError2(failure)) expect(failure.code).toBe(WorkflowErrors.codes.WORKFLOW_NOT_FOUND);
  });

  it('throws workflow.invalid when both or neither of name/script is given', async () => {
    const runs = ix.get(IWorkflowRunService);
    const failure = await runs
      .start({ name: 'test-flow', script: 'x', args: '', callerAgentId: 'main' })
      .catch((error: unknown) => error);
    expect(isError2(failure)).toBe(true);
    if (isError2(failure)) expect(failure.code).toBe(WorkflowErrors.codes.WORKFLOW_INVALID);
  });

  it('marks the run failed (never a false success) when the script throws', async () => {
    const runs = ix.get(IWorkflowRunService);
    const { runId } = await runs.start({
      script: inlineScript(`throw new Error('boom');`),
      args: '',
      callerAgentId: 'main',
    });

    await taskService.captured[0]!.started;
    const record = runs.get(runId)!;
    expect(record.status).toBe('failed');
    expect(record.error).toContain('boom');
    expect(taskService.captured[0]?.settlement).toEqual({ status: 'failed', stopReason: record.error });
    expect(events.at(-1)).toMatchObject({ type: 'workflow.run.completed', status: 'failed' });
  });

  it('cancel propagates to the task and settles killed without false success', async () => {
    subagentCompletion = (opts) =>
      new Promise<{ summary: string }>((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => { reject(new Error('aborted')); }, { once: true });
      });
    const runs = ix.get(IWorkflowRunService);
    const { runId, taskId } = await runs.start({
      script: inlineScript(`await agent('long'); return 'done';`),
      args: '',
      callerAgentId: 'main',
    });

    await waitFor(() => subagentRuns.length === 1);
    expect(runs.cancel(runId)).toBe(true);

    await taskService.captured[0]!.started;
    const record = runs.get(runId)!;
    expect(record.status).toBe('cancelled');
    expect(taskService.captured[0]?.settlement).toEqual({ status: 'killed' });
    // A late agent_call outcome event may land after `completed` (the abort
    // verdict wins the race while the in-flight host call still settles), so
    // assert presence rather than last position.
    expect(
      events.some(
        (event) => event.type === 'workflow.run.completed' && event.status === 'cancelled',
      ),
    ).toBe(true);

    expect(runs.cancel(runId)).toBe(false);
    expect(taskId).toBe('task-1');
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
