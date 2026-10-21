import { onScopeDispose } from '@vue/reactivity';

import { useAgent, useSession, useToolHandler } from '#/app/index';
import { useCleanup } from '#/kernel/index';
import type { MessageResolver } from '@moonshot-ai/agent-core/llm/policy/resolver';
import type { LlmRecovery } from '@moonshot-ai/agent-core/llm/policy/recovery';
import type { LlmRetryable } from '@moonshot-ai/agent-core/llm/policy/retry';
import type { LoopEmitted, WaitForTasks } from '@moonshot-ai/agent-core/loop/index';
import type { BlobStore } from '@moonshot-ai/agent-core/blob/index';
import type { ToolDefinition } from '@moonshot-ai/agent-core/tool/index';

import { syncAgentTools, type AgentRuntime } from './agents';

export function useAgentRuntime(): AgentRuntime {
  const agent = useAgent();
  const runtime = useSession().agentRuntime(agent.id);
  if (runtime === undefined) throw new Error(`agent '${agent.id}' was not opened by session.ensureAgent`);
  return runtime;
}

function remove<T>(list: T[], value: T): void {
  const index = list.indexOf(value);
  if (index >= 0) list.splice(index, 1);
}

export function useAgentTools(...definitions: ToolDefinition[]): void {
  const agent = useAgent();
  const runtime = useAgentRuntime();
  for (const definition of definitions) {
    if (definition.name === '') throw new TypeError('tool name must be a non-empty string');
    if (runtime.tools.has(definition.name)) throw new Error(`duplicate tool '${definition.name}'`);
    runtime.tools.set(definition.name, definition);
    useToolHandler(definition);
  }
  syncAgentTools(agent, runtime);
  onScopeDispose(() => {
    for (const definition of definitions) {
      if (runtime.tools.get(definition.name) === definition) runtime.tools.delete(definition.name);
    }
    syncAgentTools(agent, runtime);
  });
}

export function useMessageResolver(resolver: MessageResolver): void {
  const runtime = useAgentRuntime();
  runtime.resolvers.push(resolver);
  onScopeDispose(() => remove(runtime.resolvers, resolver));
}

export function useLlmRecovery(recovery: LlmRecovery): void {
  const runtime = useAgentRuntime();
  runtime.recoveries.push(recovery);
  onScopeDispose(() => remove(runtime.recoveries, recovery));
}

export function useLlmRetryable(retryable: LlmRetryable): void {
  const runtime = useAgentRuntime();
  runtime.retryables.push(retryable);
  onScopeDispose(() => remove(runtime.retryables, retryable));
}

export function useLoopEvent<T extends LoopEmitted['type']>(
  type: T,
  handler: (event: Extract<LoopEmitted, { type: T }>) => void,
): void {
  const agent = useAgent();
  const unsubscribe = agent.loop.subscribe((event) => {
    if (event.type === type) handler(event as Extract<LoopEmitted, { type: T }>);
  });
  useCleanup(unsubscribe);
}

export function useBlobs(): BlobStore {
  return useSession().blobs;
}

export function useWaitForTasks(): WaitForTasks {
  return useAgent().loop.waitForTasks;
}
