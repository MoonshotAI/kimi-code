import { dispatchTools, type PromptGate, type ScopeFactory } from '#/agent/machine';
import type { AgentEventStore } from '#/agent/slices';
import { createTurnMachine, type CreateTurnMachineOptions } from '#/agent/turn';
import type { LlmRequester } from '#/llm/requester/requester';
import { createToolMachine } from '#/tool/machine';
import type { ToolDefinition } from '#/tool/tool';

export interface TestScopeOptions {
  readonly store: AgentEventStore;
  readonly requester: LlmRequester;
  readonly tools?: readonly ToolDefinition[];
  readonly turnOptions?: CreateTurnMachineOptions;
  readonly promptGate?: PromptGate;
}

export function testScopeFactory(options: TestScopeOptions): ScopeFactory {
  const tools = options.tools ?? [];
  return () =>
    Promise.resolve({
      store: options.store,
      turnLogic: createTurnMachine(options.requester, options.turnOptions),
      toolLogic: createToolMachine(dispatchTools(tools)),
      tools,
      promptGate: options.promptGate,
    });
}
