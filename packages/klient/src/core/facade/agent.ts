import type { IAgentCommandService } from '@moonshot-ai/agent-core-v2/agent/command/agentCommand';
import type { IAgentMcpService } from '@moonshot-ai/agent-core-v2/agent/mcp/mcp';
import type { IAgentEnvironmentBindingService } from '@moonshot-ai/agent-core-v2/agent/environmentBinding/environmentBinding';

import type { ISessionTokenCountingService } from '@moonshot-ai/agent-core-v2/session/tokenCounting/sessionTokenCounting';
import type { IAgentPlanService } from '@moonshot-ai/agent-core-v2/features/plan/plan';
import type { IAgentLoopService } from '@moonshot-ai/agent-core-v2/agent/loop/loop';
import type { IAgentShellCommandService } from '@moonshot-ai/agent-core-v2/agent/shellCommand/shellCommand';
import type { IAgentSkillService } from '@moonshot-ai/agent-core-v2/features/skill/skillService';
import type { IAgentTaskService } from '@moonshot-ai/agent-core-v2/agent/task/task';
import type { ISessionUsageService } from '@moonshot-ai/agent-core-v2/session/usage/sessionUsage';
import {
  fromCoreMessage,
  type ContentPart,
} from '@moonshot-ai/agent-core-v2/human/message';
import {
  fromLlmMessage,
  type Message as LegacyMessage,
} from '@moonshot-ai/agent-core-v2/wire/message';
import type {
  ContextMessage as CoreContextMessage,
  ContextMessageTiming,
  PromptOrigin,
} from '@moonshot-ai/agent-core-v2/agent/contextMemory/types';
import type { ToolInputDisplay } from '@moonshot-ai/agent-core-v2/tool/toolInputDisplay';
import type { TokenUsage } from '@moonshot-ai/core/llm/usage';
import type { PermissionMode } from '@moonshot-ai/agent-core-v2/agent/permissionPolicy/types';

import type { ScopeRef } from '../channel.js';
import type { ScopedCaller } from './session.js';

export type PromptLaunchResult = import('@moonshot-ai/agent-core-v2/agent/loop/loop').PromptLaunchResult | undefined;
export type SteerResult = import('@moonshot-ai/agent-core-v2/agent/loop/loop').SteerResult;
export type AgentSteerEntry = {
  readonly role: 'user';
  readonly content: readonly ContentPart[];
  readonly attributes: { readonly origin: { readonly kind: 'user' } };
};
export type PromptWithSkillsInput = Omit<Parameters<IAgentSkillService['promptWithSkills']>[0], 'input'> & {
  input: readonly ContentPart[];
};
export type PromptWithSkillsResult = Awaited<ReturnType<IAgentSkillService['promptWithSkills']>>;
export type ShellCommandResult = Awaited<ReturnType<IAgentShellCommandService['run']>>;
export type SetModelResult = Awaited<ReturnType<IAgentLoopService['setModel']>>;
export type ThinkingLevel = ReturnType<IAgentLoopService['getEffectiveThinkingLevel']>;
export type UsageStatus = Awaited<ReturnType<ISessionUsageService['status']>>;
type AgentContextMessage = LegacyMessage & {
  readonly id?: string;
  readonly providerMessageId?: string;
  readonly origin?: PromptOrigin;
  readonly isError?: boolean;
  toolCallDisplays?: Record<string, ToolInputDisplay>;
  readonly note?: string;
  readonly usage?: TokenUsage;
  readonly llmTiming?: ContextMessageTiming;
  readonly durationMs?: number;
};
export type AgentContextData = {
  history: readonly AgentContextMessage[];
  tokenCount: ReturnType<ISessionTokenCountingService['statusSize']>;
};
export type AgentCommandInfo = Awaited<ReturnType<IAgentCommandService['list']>>[number];
export type EnvironmentBinding = IAgentEnvironmentBindingService['current'];
export type PlanData = Awaited<ReturnType<IAgentPlanService['status']>>;
export type AgentTaskInfo = Awaited<ReturnType<IAgentTaskService['list']>>[number];
export type McpServerEntry = ReturnType<IAgentMcpService['list']>[number];

function withoutUndefined<T extends object>(value: T): T {
  const output = { ...value };
  for (const key of Object.keys(output) as (keyof T)[]) {
    if (output[key] === undefined) delete output[key];
  }
  return output;
}

export interface AgentFacade {
  prompt(input: {
    input: readonly ContentPart[];
    promptId?: string;
    rejectIfBusy?: boolean;
  }): Promise<PromptLaunchResult>;
  promptWithSkills(input: PromptWithSkillsInput): Promise<PromptWithSkillsResult>;
  steer(input: { input: readonly ContentPart[]; promptId?: string }): Promise<SteerResult>;
  activateSkill(input: { name: string; path?: string; args?: string }): Promise<PromptLaunchResult>;
  cancel(input?: { turnId?: number; promptId?: string }): Promise<void>;
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
  getEnvironment(): Promise<EnvironmentBinding>;
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
      call(scope, 'agentLoopService', 'submit', [input]) as Promise<PromptLaunchResult>,
    promptWithSkills: (input) =>
      call(scope, 'agentSkillService', 'promptWithSkills', [input]) as Promise<PromptWithSkillsResult>,
    steer: (input) => {
      const entry: AgentSteerEntry = {
        role: 'user',
        content: input.input,
        attributes: {
          origin: { kind: 'user' },
          ...(input.promptId === undefined ? {} : { promptId: input.promptId }),
        },
      };
      return call(scope, 'agentLoopService', 'notifyClient', [entry]) as Promise<SteerResult>;
    },
    activateSkill: (input) =>
      call(scope, 'agentSkillService', 'activate', [input]) as Promise<PromptLaunchResult>,
    cancel: (input) =>
      (input?.promptId === undefined
        ? call(scope, 'agentLoopService', 'cancelFromUser', input?.turnId === undefined ? [] : [input.turnId])
        : call(scope, 'agentLoopService', 'cancelPrompt', [input.promptId])) as Promise<void>,
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
      const legacyHistory = (history as readonly CoreContextMessage[]).map((message) =>
        withoutUndefined({
          ...fromLlmMessage(fromCoreMessage(message)),
          id: message.id,
          providerMessageId: message.providerMessageId,
          name: message.name,
          origin: message.origin,
          isError: message.isError,
          partial: message.partial,
          toolCallDisplays: message.toolCallDisplays,
          note: message.note,
          usage: message.usage,
          llmTiming: message.llmTiming,
          durationMs: message.durationMs,
        }),
      );
      return { history: legacyHistory, tokenCount: tokenCount as AgentContextData['tokenCount'] };
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
    getEnvironment: () =>
      call(scope, 'agentEnvironmentBindingService', 'current', []) as Promise<EnvironmentBinding>,
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
