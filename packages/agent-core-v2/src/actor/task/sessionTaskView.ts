import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { Error2, ErrorCodes } from '#/errors';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

import { AgentTask, type TaskRuntime } from './taskAgentRuntime';
import type { AgentTaskInfo } from './types';

export interface SessionTaskEntry {
  readonly ownerAgentId: string;
  readonly info: AgentTaskInfo;
}

export interface ISessionTaskView {
  readonly _serviceBrand: undefined;
  list(activeOnly?: boolean, limit?: number): readonly SessionTaskEntry[];
  get(taskId: string): SessionTaskEntry | undefined;
  readOutput(taskId: string, tail?: number): Promise<string>;
  stop(taskId: string, reason?: string): Promise<AgentTaskInfo | undefined>;
  stopByUser(taskId: string): Promise<AgentTaskInfo | undefined>;
}

export const ISessionTaskView: ServiceIdentifier<ISessionTaskView> =
  createDecorator<ISessionTaskView>('sessionTaskView');

export class SessionTaskViewService extends Disposable implements ISessionTaskView {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentLifecycleService private readonly manager: IAgentLifecycleService,
  ) {
    super();
  }

  private tasksOf(agent: AgentContext): TaskRuntime {
    return this.manager.resolve(agent, AgentTask);
  }

  list(activeOnly = true, limit?: number): readonly SessionTaskEntry[] {
    const result: SessionTaskEntry[] = [];
    for (const agent of this.manager.list()) {
      for (const info of this.tasksOf(agent).list(activeOnly)) {
        result.push({ ownerAgentId: agent.agentId, info });
        if (limit !== undefined && result.length >= limit) return result;
      }
    }
    return result;
  }

  get(taskId: string): SessionTaskEntry | undefined {
    const found = this.ownerOf(taskId);
    if (found === undefined) return undefined;
    return { ownerAgentId: found.agent.agentId, info: found.info };
  }

  readOutput(taskId: string, tail?: number): Promise<string> {
    const found = this.ownerOf(taskId);
    if (found === undefined) return Promise.resolve('');
    return this.tasksOf(found.agent).readOutput(taskId, tail);
  }

  stop(taskId: string, reason?: string): Promise<AgentTaskInfo | undefined> {
    const found = this.ownerOf(taskId);
    if (found === undefined) return Promise.resolve(undefined);
    return this.tasksOf(found.agent).stop(taskId, reason);
  }

  stopByUser(taskId: string): Promise<AgentTaskInfo | undefined> {
    const found = this.ownerOf(taskId);
    if (found === undefined) return Promise.resolve(undefined);
    return this.tasksOf(found.agent).stopByUser(taskId);
  }

  private ownerOf(taskId: string): { readonly agent: AgentContext; readonly info: AgentTaskInfo } | undefined {
    let found: { readonly agent: AgentContext; readonly info: AgentTaskInfo } | undefined;
    for (const agent of this.manager.list()) {
      const info = this.tasksOf(agent).getTask(taskId);
      if (info === undefined) continue;
      if (found !== undefined) {
        throw new Error2(
          ErrorCodes.TASK_ID_CONFLICT,
          `Task id '${taskId}' is owned by more than one agent in this session`,
          { details: { taskId } },
        );
      }
      found = { agent, info };
    }
    return found;
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionTaskView,
  SessionTaskViewService,
  ScopeActivation.OnScopeCreated,
  'sessionTaskView',
);
