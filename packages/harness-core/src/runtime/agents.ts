import { createMaxStepsHook, type HookRegistration } from '@moonshot-ai/agent-core/loop/index';
import type { Agent, AgentCaps } from '@moonshot-ai/agent-core/session/index';
import { createToolExecutor, type ToolDefinition, type ToolExecutorHost } from '@moonshot-ai/agent-core/tool/index';

export interface AgentRuntime {
  readonly agentId: string;
  readonly executor: ToolExecutorHost;
  readonly tools: Map<string, ToolDefinition>;
  hostSystemPrompt: string | undefined;
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

export function syncAgentTools(agent: Agent, runtime: AgentRuntime): void {
  const descriptions = [...runtime.tools.values()].map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    deferred: tool.deferred,
  }));
  const ack = agent.loop.setTools(descriptions);
  if (ack?.type !== 'tools.rejected') return;
  const unsubscribe = agent.loop.subscribe((event) => {
    if (event.type !== 'step.ended' && event.type !== 'turn.ended') return;
    unsubscribe();
    queueMicrotask(() => syncAgentTools(agent, runtime));
  });
}
