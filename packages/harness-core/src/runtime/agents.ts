import type { MessageResolver } from '@moonshot-ai/agent-core/llm/policy/resolver';
import type { LlmRecovery } from '@moonshot-ai/agent-core/llm/policy/recovery';
import type { LlmRetryable } from '@moonshot-ai/agent-core/llm/policy/retry';
import { createMaxStepsHook, type HookRegistration, type LoopLlmRequester } from '@moonshot-ai/agent-core/loop/index';
import type { Agent, AgentCaps } from '@moonshot-ai/agent-core/session/index';
import { createToolExecutor, type ToolDefinition, type ToolExecutorHost } from '@moonshot-ai/agent-core/tool/index';

export const HOST_SYSTEM_PROMPT_ID = 'host';

export interface SystemPromptSection {
  readonly id: string;
  readonly text: string;
  readonly priority?: number;
}

export interface AgentRuntime {
  readonly agentId: string;
  requester: LoopLlmRequester | undefined;
  readonly resolvers: MessageResolver[];
  readonly recoveries: LlmRecovery[];
  readonly retryables: LlmRetryable[];
  readonly executor: ToolExecutorHost;
  readonly tools: Map<string, ToolDefinition>;
  readonly sections: Map<string, SystemPromptSection>;
  systemPromptSettled: boolean;
}

export interface EnsureAgentOptions {
  readonly systemPrompt?: string;
  readonly maxResultChars?: number;
  readonly maxSteps?: number;
  readonly hooks?: readonly HookRegistration[];
}

export function createAgentRuntime(agentId: string, options: EnsureAgentOptions = {}): AgentRuntime {
  const runtime: AgentRuntime = {
    agentId,
    requester: undefined,
    resolvers: [],
    recoveries: [],
    retryables: [],
    executor: createToolExecutor({ policy: { maxResultChars: options.maxResultChars } }),
    tools: new Map(),
    sections: new Map(),
    systemPromptSettled: false,
  };
  if (options.systemPrompt !== undefined) {
    runtime.sections.set(HOST_SYSTEM_PROMPT_ID, { id: HOST_SYSTEM_PROMPT_ID, text: options.systemPrompt });
  }
  return runtime;
}

export function agentCaps(runtime: AgentRuntime, options: EnsureAgentOptions = {}): AgentCaps {
  const hooks = [
    ...(options.maxSteps !== undefined ? [createMaxStepsHook(() => options.maxSteps)] : []),
    ...(options.hooks ?? []),
  ];
  return {
    requester: () => {
      const base = runtime.requester;
      if (base === undefined) throw new Error(`agent '${runtime.agentId}' has no requester`);
      return base.with({
        policy: {
          resolvers: () => [...runtime.resolvers],
          recoveries: () => [...runtime.recoveries],
          retryables: () => [...runtime.retryables],
        },
      });
    },
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

export function assembleSystemPrompt(sections: ReadonlyMap<string, SystemPromptSection>): string {
  return [...sections.values()]
    .filter((section) => section.text.trim() !== '')
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    .map((section) => section.text)
    .join('\n\n');
}

export function settleSystemPrompt(agent: Agent, runtime: AgentRuntime): void {
  if (runtime.systemPromptSettled) return;
  runtime.systemPromptSettled = true;
  queueMicrotask(() => {
    if (agent.loop.state.profile.systemPrompt !== undefined) return;
    const text = assembleSystemPrompt(runtime.sections);
    agent.loop.setSystemPrompt(text === '' ? undefined : text);
  });
}
