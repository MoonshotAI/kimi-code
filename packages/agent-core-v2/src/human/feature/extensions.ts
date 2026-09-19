import type { TurnBeforeStep } from '#/agent/turn';
import { createToken, currentUnit, inject, pushCleanup, type Unsubscribe } from '#/kernel/index';
import type { MessageResolver } from '#/llm/requester/actor';
import type { ToolDefinition } from '#/tool/tool';

export interface AgentExtensionRegistry {
  readonly tools: readonly ToolDefinition[];
  readonly messageResolvers: readonly MessageResolver[];
  readonly beforeSteps: readonly TurnBeforeStep[];
  registerTools(tools: readonly ToolDefinition[]): Unsubscribe;
  registerMessageResolver(resolver: MessageResolver): Unsubscribe;
  registerBeforeStep(hook: TurnBeforeStep): Unsubscribe;
}

export const AgentExtensions = createToken<AgentExtensionRegistry>('AgentExtensions');

function register<T>(entries: T[], values: readonly T[]): Unsubscribe {
  entries.push(...values);
  return () => {
    for (const value of values) {
      const index = entries.indexOf(value);
      if (index >= 0) entries.splice(index, 1);
    }
  };
}

export function createAgentExtensions(): AgentExtensionRegistry {
  const tools: ToolDefinition[] = [];
  const messageResolvers: MessageResolver[] = [];
  const beforeSteps: TurnBeforeStep[] = [];
  return {
    tools,
    messageResolvers,
    beforeSteps,
    registerTools: (values) => {
      const names = new Set(tools.map((tool) => tool.name));
      for (const tool of values) {
        if (names.has(tool.name)) throw new Error(`duplicate tool name: '${tool.name}'`);
        names.add(tool.name);
      }
      return register(tools, values);
    },
    registerMessageResolver: (resolver) => {
      if (messageResolvers.some((entry) => entry.id === resolver.id)) {
        throw new Error(`duplicate message resolver: '${resolver.id}'`);
      }
      return register(messageResolvers, [resolver]);
    },
    registerBeforeStep: (hook) => register(beforeSteps, [hook]),
  };
}

export function useAgentTools(...tools: readonly ToolDefinition[]): void {
  pushCleanup(currentUnit(), inject(AgentExtensions).registerTools(tools));
}

export function useMessageResolver(resolver: MessageResolver): void {
  pushCleanup(currentUnit(), inject(AgentExtensions).registerMessageResolver(resolver));
}

export function useBeforeStep(hook: TurnBeforeStep): void {
  pushCleanup(currentUnit(), inject(AgentExtensions).registerBeforeStep(hook));
}
