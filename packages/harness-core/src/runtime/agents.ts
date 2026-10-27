import { createMaxStepsHook, type HookRegistration } from '@moonshot-ai/agent-core/loop/index';
import type { AgentCaps } from '@moonshot-ai/agent-core/session/index';
import type { ToolDescription } from '@moonshot-ai/agent-core/llm/message';
import { createToolExecutor, type ToolDefinition, type ToolExecutorHost } from '@moonshot-ai/agent-core/tool/index';

import type { ProfileSync } from './profile-sync';

export interface AgentProfileSync {
  readonly prompt: ProfileSync;
  readonly tools: ProfileSync;
}

export interface AgentRuntime {
  readonly agentId: string;
  readonly executor: ToolExecutorHost;
  readonly tools: Map<string, ToolDefinition>;
  hostSystemPrompt: string | undefined;
  profileSync?: AgentProfileSync;
}

export interface EnsureAgentOptions {
  readonly systemPrompt?: string;
  readonly maxResultChars?: number;
  readonly maxSteps?: number;
  readonly hooks?: readonly HookRegistration[];
}

export function createAgentRuntime(agentId: string, options: EnsureAgentOptions = {}): AgentRuntime {
  return {
    agentId,
    executor: createToolExecutor({ policy: { maxResultChars: options.maxResultChars } }),
    tools: new Map(),
    hostSystemPrompt: options.systemPrompt,
  };
}

export function agentCaps(runtime: AgentRuntime, options: EnsureAgentOptions = {}): AgentCaps {
  const hooks = [
    ...(options.maxSteps !== undefined ? [createMaxStepsHook(() => options.maxSteps)] : []),
    ...(options.hooks ?? []),
  ];
  return {
    executor: runtime.executor,
    hooks,
  };
}

export function toolDescription(tool: ToolDefinition): ToolDescription {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.deferred === true ? { deferred: true } : {}),
  };
}
