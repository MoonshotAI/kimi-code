/**
 * The agent facade — one `session.agent(id)` handle over the `agentRPCService`
 * channel (the single agent-scope facade service the wire exposes). Prompt
 * streaming is NOT on this interface: it flows through the agent's `events`
 * hub (`turn.*`, `assistant.delta`, `tool.call.*`, `prompt.completed`, …).
 */

import type { IAgentRPCService } from '@moonshot-ai/agent-core-v2/agent/rpc/rpc';
import type { ContentPart } from '@moonshot-ai/agent-core-v2/kosong/contract/message';
import type { PermissionMode } from '@moonshot-ai/agent-core-v2/agent/permissionPolicy/types';

import type { ScopeRef } from '../channel.js';
import type { ScopedCaller } from './session.js';

// Wire-type aliases derived through the RPC interface (keeps klient free of
// protocol-package imports).
export type PromptLaunchResult = Awaited<ReturnType<IAgentRPCService['prompt']>>;
export type ShellCommandResult = Awaited<ReturnType<IAgentRPCService['runShellCommand']>>;
export type SetModelResult = Awaited<ReturnType<IAgentRPCService['setModel']>>;
export type UsageStatus = Awaited<ReturnType<IAgentRPCService['getUsage']>>;
export type AgentContextData = Awaited<ReturnType<IAgentRPCService['getContext']>>;
export type PlanData = Awaited<ReturnType<IAgentRPCService['getPlan']>>;
export type AgentTaskInfo = Awaited<ReturnType<IAgentRPCService['getTasks']>>[number];

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
    runShellCommand: (input) => rpc('runShellCommand', input) as Promise<ShellCommandResult>,
    cancelShellCommand: (input) => rpc('cancelShellCommand', input) as Promise<void>,
    getModel: () => rpc('getModel', {}) as Promise<string>,
    setModel: (model) => rpc('setModel', { model }) as Promise<SetModelResult>,
    setPermission: (mode) => rpc('setPermission', { mode }) as Promise<void>,
    getUsage: () => rpc('getUsage', {}) as Promise<UsageStatus>,
    getContext: () => rpc('getContext', {}) as Promise<AgentContextData>,
    getPlan: () => rpc('getPlan', {}) as Promise<PlanData>,
    enterPlan: () => rpc('enterPlan', {}) as Promise<void>,
    clearPlan: () => rpc('clearPlan', {}) as Promise<void>,
    cancelPlan: (input) => rpc('cancelPlan', input ?? {}) as Promise<void>,
    getTasks: (input) => rpc('getTasks', input ?? {}) as Promise<readonly AgentTaskInfo[]>,
    stopTask: (input) => rpc('stopTask', input) as Promise<void>,
    getTaskOutput: (input) => rpc('getTaskOutput', input) as Promise<string>,
  };
}
