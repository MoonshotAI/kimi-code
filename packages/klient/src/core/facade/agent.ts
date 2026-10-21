import type { IAgentCommandService } from '@moonshot-ai/agent-core-v2/agent/command/agentCommand';
import type { IAgentContextMemoryService } from '@moonshot-ai/agent-core-v2/agent/contextMemory/contextMemory';
import type { IAgentMcpService } from '@moonshot-ai/agent-core-v2/agent/mcp/mcp';
import type { IAgentRuntimeBindingService } from '@moonshot-ai/agent-core-v2/agent/runtimeBinding/runtimeBinding';

import type { ISessionTokenCountingService } from '@moonshot-ai/agent-core-v2/session/tokenCounting/sessionTokenCounting';
import type { IAgentPlanService } from '@moonshot-ai/agent-core-v2/features/plan/plan';
import type { IAgentProfileService } from '@moonshot-ai/agent-core-v2/agent/profile/profile';
import type { IAgentShellCommandService } from '@moonshot-ai/agent-core-v2/agent/shellCommand/shellCommand';
import type { IAgentSkillService } from '@moonshot-ai/agent-core-v2/features/skill/skillService';
import type { IAgentTaskService } from '@moonshot-ai/agent-core-v2/agent/task/task';
import type { ISessionUsageService } from '@moonshot-ai/agent-core-v2/session/usage/sessionUsage';
import type { ContentPart } from '@moonshot-ai/agent-core-v2/human/llm/message';
import type { PermissionMode } from '@moonshot-ai/agent-core-v2/agent/permissionPolicy/types';

import type { ScopeRef } from '../channel.js';
import type { ScopedCaller } from './session.js';

export type PromptLaunchResult = import('@moonshot-ai/agent-core-v2/agent/loop/loop').PromptLaunchResult | undefined;
export type PromptWithSkillsInput = Parameters<IAgentSkillService['promptWithSkills']>[0];
export type PromptWithSkillsResult = Awaited<ReturnType<IAgentSkillService['promptWithSkills']>>;
export type ShellCommandResult = Awaited<ReturnType<IAgentShellCommandService['run']>>;
export type SetModelResult = Awaited<ReturnType<IAgentProfileService['setModel']>>;
export type ThinkingLevel = ReturnType<IAgentProfileService['getEffectiveThinkingLevel']>;
export type UsageStatus = Awaited<ReturnType<ISessionUsageService['status']>>;
export type AgentContextData = {
  history: ReturnType<IAgentContextMemoryService['get']>;
  tokenCount: ReturnType<ISessionTokenCountingService['statusSize']>;
};
export type AgentCommandInfo = Awaited<ReturnType<IAgentCommandService['list']>>[number];
export type RuntimeBinding = ReturnType<IAgentRuntimeBindingService['get']>;
export type PlanData = Awaited<ReturnType<IAgentPlanService['status']>>;
export type AgentTaskInfo = Awaited<ReturnType<IAgentTaskService['list']>>[number];
export type McpServerEntry = ReturnType<IAgentMcpService['list']>[number];

export interface AgentFacade {
  prompt(input: {
    input: readonly ContentPart[];
    promptId?: string;
  }): Promise<PromptLaunchResult>;
  promptWithSkills(input: PromptWithSkillsInput): Promise<PromptWithSkillsResult>;
  steer(input: { input: readonly ContentPart[] }): Promise<PromptLaunchResult>;
  activateSkill(input: { name: string; args?: string }): Promise<PromptLaunchResult>;
  cancel(input?: { turnId?: number }): Promise<void>;
  runShellCommand(input: { command: string; commandId?: string }): Promise<ShellCommandResult>;
  cancelShellCommand(input: { commandId: string }): Promise<void>;
  getModel(): Promise<string>;
  setModel(model: string): Promise<SetModelResult>;
  getThinking(): Promise<ThinkingLevel>;
  setThinking(level: string): Promise<void>;
  setPermission(mode: PermissionMode): Promise<void>;
  getUsage(): Promise<UsageStatus>;
  getContext(): Promise<AgentContextData>;
  listCommands(): Promise<readonly AgentCommandInfo[]>;
  runCommand(input: { name: string; args?: string }): Promise<void>;
  getRuntime(): Promise<RuntimeBinding>;
  switchRuntime(runtimeId: string): Promise<RuntimeBinding>;
  getPlan(): Promise<PlanData>;
  enterPlan(): Promise<void>;
  clearPlan(): Promise<void>;
  cancelPlan(input?: { id?: string }): Promise<void>;
  getTasks(input?: { activeOnly?: boolean; limit?: number }): Promise<readonly AgentTaskInfo[]>;
  stopTask(input: { taskId: string; reason?: string }): Promise<void>;
  getTaskOutput(input: { taskId: string; tail?: number }): Promise<string>;
  getMcpServers(): Promise<readonly McpServerEntry[]>;
  compact(input?: { instruction?: string }): Promise<boolean>;
}

export function createAgentFacade(call: ScopedCaller, scope: ScopeRef): AgentFacade {
  return {
    prompt: (input) =>
      call(scope, 'agentPromptService', 'submit', [input]) as Promise<PromptLaunchResult>,
    promptWithSkills: (input) =>
      call(scope, 'agentSkillService', 'promptWithSkills', [input]) as Promise<PromptWithSkillsResult>,
    steer: (input) =>
      call(scope, 'agentPromptService', 'submitSteer', [input]) as Promise<PromptLaunchResult>,
    activateSkill: (input) =>
      call(scope, 'agentSkillService', 'activate', [input]) as Promise<PromptLaunchResult>,
    cancel: (input) =>
      call(scope, 'agentLoopService', 'cancelFromUser', input?.turnId === undefined ? [] : [input.turnId]) as Promise<void>,
    runShellCommand: (input) =>
      call(scope, 'agentShellCommandService', 'run', [input]) as Promise<ShellCommandResult>,
    cancelShellCommand: (input) =>
      call(scope, 'agentShellCommandService', 'cancel', [input.commandId]) as Promise<void>,
    getModel: () => call(scope, 'agentProfileService', 'getModel', []) as Promise<string>,
    setModel: (model) =>
      call(scope, 'agentProfileService', 'setModel', [model]) as Promise<SetModelResult>,
    getThinking: () =>
      call(scope, 'agentProfileService', 'getEffectiveThinkingLevel', []) as Promise<ThinkingLevel>,
    setThinking: (level) =>
      call(scope, 'agentProfileService', 'setThinking', [level]) as Promise<void>,
    setPermission: (mode) =>
      call(scope, 'agentPermissionModeService', 'setModeAndBroadcast', [mode]) as Promise<void>,
    getUsage: () => call(scope, 'agentUsageService', 'status', []) as Promise<UsageStatus>,
    getContext: async () => {
      const [history, tokenCount] = await Promise.all([
        call(scope, 'agentContextMemoryService', 'get', []),
        call(scope, 'agentTokenCountingService', 'statusSize', []),
      ]);
      return { history, tokenCount } as AgentContextData;
    },
    listCommands: () =>
      call(scope, 'agentCommandService', 'list', []) as Promise<readonly AgentCommandInfo[]>,
    runCommand: (input) =>
      call(
        scope,
        'agentCommandService',
        'run',
        input.args === undefined ? [input.name] : [input.name, input.args],
      ) as Promise<void>,
    getRuntime: () =>
      call(scope, 'agentRuntimeBindingService', 'get', []) as Promise<RuntimeBinding>,
    switchRuntime: (runtimeId) =>
      call(scope, 'agentRuntimeBindingService', 'switch', [runtimeId]) as Promise<RuntimeBinding>,
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
    getMcpServers: () =>
      call(scope, 'agentMcpService', 'list', []) as Promise<readonly McpServerEntry[]>,
    compact: (input) =>
      call(scope, 'agentFullCompactionService', 'begin', [
        { source: 'manual', instruction: input?.instruction },
      ]) as Promise<boolean>,
  };
}
