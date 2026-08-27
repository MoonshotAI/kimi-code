import { afterEach, describe, expect, it } from 'vitest';

import type { ExecutableTool, ToolExecution } from '#/tool/toolContract';
import { AgentTools, type AgentToolsRuntime } from '#/features/toolExecutor/toolExecutorAgentRuntime';
import { createTestAgent, type TestAgentContext } from '../../harness';

class TestTool implements ExecutableTool {
  constructor(readonly name: string) {}
  readonly description = 'test';
  readonly parameters = { type: 'object' };
  resolveExecution(): ToolExecution {
    return {
      approvalRule: this.name,
      execute: async () => ({ output: this.name }),
    };
  }
}

describe('AgentTools provider lifecycle', () => {
  let contexts: TestAgentContext[] = [];

  afterEach(async () => {
    await Promise.all(contexts.map((context) => context.dispose()));
    contexts = [];
  });

  function create(): { readonly context: TestAgentContext; readonly tools: AgentToolsRuntime } {
    const context = createTestAgent();
    contexts.push(context);
    return { context, tools: context.resolve(AgentTools) };
  }

  it('materializes a contributed provider lazily and withdraws it on disposal', async () => {
    const { context, tools } = create();
    const contribution = context.provideTool(new TestTool('Alpha'));
    await Promise.resolve();
    expect(tools.resolve('Alpha')).toBeDefined();
    contribution.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tools.resolve('Alpha')).toBeUndefined();
  });

  it('isolates providers between agents', async () => {
    const first = create();
    const second = create();
    first.context.provideTool(new TestTool('First'));
    second.context.provideTool(new TestTool('Second'));
    await Promise.resolve();
    expect(first.tools.resolve('First')).toBeDefined();
    expect(first.tools.resolve('Second')).toBeUndefined();
    expect(second.tools.resolve('Second')).toBeDefined();
    expect(second.tools.resolve('First')).toBeUndefined();
  });

  it('updates the catalog when a provider changes', async () => {
    const { context, tools } = create();
    const first = context.provideTool(new TestTool('First'));
    await Promise.resolve();
    expect(tools.resolve('First')).toBeDefined();
    first.dispose();
    const second = context.provideTool(new TestTool('Second'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tools.resolve('First')).toBeUndefined();
    expect(tools.resolve('Second')).toBeDefined();
    second.dispose();
  });
});
