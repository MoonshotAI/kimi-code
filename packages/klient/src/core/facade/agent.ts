/**
 * The agent facade — one `session.agent(id)` handle over the agent-scope
 * services the wire exposes. Turn-driving calls (prompt / steer / cancel) go
 * through the `agentRPCService` channel; shell commands, model, usage, plan,
 * and task calls go straight to their domain services. Prompt streaming is
 * NOT on this interface: it flows through the agent's `events` hub
 * (`turn.*`, `assistant.delta`, `tool.call.*`, `prompt.completed`, …).
 */

import type { IAgentRPCService } from '@moonshot-ai/agent-core-v2/agent/rpc/rpc';
import type { IAgentPlanService } from '@moonshot-ai/agent-core-v2/agent/plan/plan';
import type { IAgentProfileService } from '@moonshot-ai/agent-core-v2/agent/profile/profile';
import type { IAgentShellCommandService } from '@moonshot-ai/agent-core-v2/agent/shellCommand/shellCommand';
import type { IAgentTaskService } from '@moonshot-ai/agent-core-v2/agent/task/task';
import type { IAgentUsageService } from '@moonshot-ai/agent-core-v2/agent/usage/usage';
import type { ContentPart } from '@moonshot-ai/agent-core-v2/kosong/contract/message';
import type { PermissionMode } from '@moonshot-ai/agent-core-v2/agent/permissionPolicy/types';

import type { ScopeRef } from '../channel.js';
import type { ScopedCaller } from './session.js';

// Wire-type aliases derived through the engine service interfaces (keeps
// klient free of protocol-package imports).
export type PromptLaunchResult = Awaited<ReturnType<IAgentRPCService['prompt']>>;
export type ShellCommandResult = Awaited<ReturnType<IAgentShellCommandService['run']>>;
export type SetModelResult = Awaited<ReturnType<IAgentProfileService['setModel']>>;
export type UsageStatus = Awaited<ReturnType<IAgentUsageService['status']>>;
export type AgentContextData = Awaited<ReturnType<IAgentRPCService['getContext']>>;
export type PlanData = Awaited<ReturnType<IAgentPlanService['status']>>;
export type AgentTaskInfo = Awaited<ReturnType<IAgentTaskService['list']>>[number];

export interface AgentFacade {
  prompt(input: {
    input: readonly ContentPart[];
    disabledTools?: readonly string[];
  }): Promise<PromptLaunchResult>;
  steer(input: { input: readonly ContentPart[] }): Promise<PromptLaunchResult>;
  cancel(input?: { turnId?: number }): Promise<void>;
  runShellCommand(input: { command: string; commandId?: string }): Promise<ShellCommandResult>;
  cancelShellCommand(input: { commandId: string }): Promise<void>;
  getModel(): Promise<string>;
  setModel(model: string): Promise<SetModelResult>;
  setPermission(mode: PermissionMode): Promise<void>;
  getUsage(): Promise<UsageStatus>;
  getContext(): Promise<AgentContextData>;
  getPlan(): Promise<PlanData>;
  enterPlan(): Promise<void>;
  clearPlan(): Promise<void>;
  cancelPlan(input?: { id?: string }): Promise<void>;
  getTasks(input?: { activeOnly?: boolean; limit?: number }): Promise<readonly AgentTaskInfo[]>;
  stopTask(input: { taskId: string; reason?: string }): Promise<void>;
  getTaskOutput(input: { taskId: string; tail?: number }): Promise<string>;
}

export function createAgentFacade(call: ScopedCaller, scope: ScopeRef): AgentFacade {
  const rpc = (method: string, payload: unknown): Promise<unknown> =>
    call(scope, 'agentRPCService', method, [payload]);

  return {
    prompt: (input) => rpc('prompt', input) as Promise<PromptLaunchResult>,
    steer: (input) => rpc('steer', input) as Promise<PromptLaunchResult>,
    cancel: (input) => rpc('cancel', input ?? {}) as Promise<void>,
    runShellCommand: (input) =>
      call(scope, 'agentShellCommandService', 'run', [input]) as Promise<ShellCommandResult>,
    cancelShellCommand: (input) =>
      call(scope, 'agentShellCommandService', 'cancel', [input.commandId]) as Promise<void>,
    getModel: () => call(scope, 'agentProfileService', 'getModel', []) as Promise<string>,
    setModel: (model) =>
      call(scope, 'agentProfileService', 'setModel', [model]) as Promise<SetModelResult>,
    setPermission: (mode) => rpc('setPermission', { mode }) as Promise<void>,
    getUsage: () => call(scope, 'agentUsageService', 'status', []) as Promise<UsageStatus>,
    getContext: () => rpc('getContext', {}) as Promise<AgentContextData>,
    getPlan: () => call(scope, 'agentPlanService', 'status', []) as Promise<PlanData>,
    enterPlan: () => call(scope, 'agentPlanService', 'enter', []) as Promise<void>,
    clearPlan: () => call(scope, 'agentPlanService', 'clear', []) as Promise<void>,
    cancelPlan: (input) =>
      call(scope, 'agentPlanService', 'cancel', [input?.id]) as Promise<void>,
    getTasks: (input) =>
      call(scope, 'agentTaskService', 'list', [
        input?.activeOnly ?? false,
        input?.limit,
      ]) as Promise<readonly AgentTaskInfo[]>,
    stopTask: async (input) => {
      if (input.reason === undefined) {
        await call(scope, 'agentTaskService', 'stopByUser', [input.taskId]);
        return;
      }
      await call(scope, 'agentTaskService', 'stop', [input.taskId, input.reason]);
    },
    getTaskOutput: (input) =>
      call(scope, 'agentTaskService', 'readOutput', [input.taskId, input.tail]) as Promise<string>,
  };
}
