import { join } from 'pathe';
import { createActor, type Actor } from 'xstate';

import type { TestInstantiationService } from '#/_base/di/test';
import { toDisposable } from '#/_base/di/lifecycle';
import type { AgentTaskInfo } from '#/actor/task/types';
import { AgentTask, TaskRuntime } from '#/actor/task/taskAgentRuntime';
import { AgentTaskPersistence } from '#/actor/task/internal/persist';
import { taskActorLogic } from '#/actor/task/internal/taskMachine';
import type { TaskModelState } from '#/actor/task/taskOps';
import {
  defineAgentRuntimeProvider,
  type AgentRuntimeContext,
  type AgentRuntimeProvider,
} from '#/actor/agentRuntime';
import { IAgentHostService } from '#/agent/host/agentHost';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventBus } from '#/app/event/eventBus';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { IEventDispatcher } from '#/state/eventDispatcher';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';

export type TaskServiceTestManager = TaskRuntime & {
  loadFromDisk(): Promise<void>;
  reconcile(): Promise<readonly AgentTaskInfo[]>;
};

export const TASK_TEST_SESSION_SCOPE = 'sessions/test-workspace/test-session';

export const TASK_TEST_AGENT_SCOPE = `${TASK_TEST_SESSION_SCOPE}/agents/main`;

export function createAgentTaskPersistence(homedir: string): AgentTaskPersistence {
  const storage = new FileStorageService(homedir);
  return new AgentTaskPersistence(
    join(homedir, TASK_TEST_AGENT_SCOPE),
    TASK_TEST_AGENT_SCOPE,
    new JsonAtomicDocumentStore(storage),
    storage,
  );
}

export function writeLegacyTaskFile(homedir: string, task: AgentTaskInfo): Promise<void> {
  const storage = new FileStorageService(homedir);
  const docs = new JsonAtomicDocumentStore(storage);
  return docs.set(`${TASK_TEST_AGENT_SCOPE}/tasks`, `${task.taskId}.json`, task);
}

export function stubTaskRuntimeProvider(
  runtime: () => Partial<TaskRuntime>,
): AgentRuntimeProvider<TaskRuntime> {
  return defineAgentRuntimeProvider(AgentTask, {
    id: 'task',
    createApi: () => runtime() as TaskRuntime,
  });
}

export class TestTaskRuntime extends TaskRuntime {
  constructor(
    context: AgentRuntimeContext<TaskModelState>,
    private readonly actor: Actor<typeof taskActorLogic>,
  ) {
    super(context);
  }

  beginRestore(): Promise<void> {
    const readiness: Promise<unknown>[] = [];
    this.actor.send({
      type: 'runtime.restore',
      waitUntil: (work) => {
        readiness.push(work);
      },
    });
    return Promise.all(readiness).then(() => undefined);
  }

  shutdown(): void {
    this.actor.stop();
  }
}

export interface TaskRuntimeTestOptions {
  readonly ix: TestInstantiationService;
  readonly agentScope: IAgentScopeContext;
  readonly dispatcher: IEventDispatcher;
  readonly registry: () => TaskModelState;
}

export function createTaskRuntimeForTest(options: TaskRuntimeTestOptions): TestTaskRuntime {
  const { ix, agentScope, dispatcher, registry } = options;
  const host = {
    scopeContext: agentScope,
    telemetry: ix.get(ITelemetryService),
    eventBus: ix.get(IEventBus),
    dispatcher,
    state: ix.get(IAgentStateService),
  };
  let actor!: Actor<typeof taskActorLogic>;
  const context: AgentRuntimeContext<TaskModelState> = {
    agent: agentScope.agentContext,
    get: (id) =>
      ((id as unknown) === IAgentHostService
        ? ({ of: () => host } as unknown)
        : ix.get(id)) as never,
    getState: () => registry(),
    getLogicState: <T,>() => actor.getSnapshot().context as T,
    dispatch: (event) => dispatcher.dispatch(event),
    send: (event) => {
      actor.send(event as never);
    },
    onDidChange: () => toDisposable(() => {}),
  };
  actor = createActor(taskActorLogic, { input: context });
  actor.start();
  return new TestTaskRuntime(context, actor);
}
