import { afterEach, describe, expect, it } from 'vitest';

import { AgentTools } from '#/features/toolExecutor/toolExecutorAgentRuntime';
import { IAgentUserToolService, type UserToolRegistration } from '#/agent/userTool/userTool';
import { createTestAgent, type TestAgentContext } from '../../harness';

const toolA: UserToolRegistration = {
  name: 'Lookup',
  description: 'Look up a short test value.',
  parameters: { type: 'object', properties: { query: { type: 'string' } } },
};
const toolB: UserToolRegistration = {
  name: 'Echo',
  description: 'Echo the input.',
  parameters: { type: 'object', properties: { text: { type: 'string' } } },
};
const deferredTool: UserToolRegistration = {
  name: 'DashboardCreate',
  description: 'Create a dashboard.',
  parameters: { type: 'object', properties: { title: { type: 'string' } } },
  disclosure: 'deferred',
};

function setup(): TestAgentContext {
  return createTestAgent();
}

const contexts: TestAgentContext[] = [];
function track(ctx: TestAgentContext): TestAgentContext {
  contexts.push(ctx);
  return ctx;
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.dispose()));
});

describe('AgentUserToolService (AgentTools provider)', () => {
  it('register persists the model, exposes a provider snapshot, and activates the profile', () => {
    const ctx = track(setup());
    const service = ctx.get(IAgentUserToolService);
    const tools = ctx.resolve(AgentTools);
    service.register(toolA);
    expect(service.list()).toEqual([toolA]);
    expect(tools.availableTools().find((tool) => tool.name === toolA.name)).toBeDefined();
    expect(tools.isActive(toolA.name, 'user')).toBe(true);
  });

  it('preserves deferred disclosure in the provider snapshot', () => {
    const ctx = track(setup());
    ctx.get(IAgentUserToolService).register(deferredTool);
    expect(ctx.resolve(AgentTools).availableTools().find((tool) => tool.name === deferredTool.name)).toEqual(
      expect.objectContaining({ name: deferredTool.name, source: 'user', disclosure: 'deferred' }),
    );
  });

  it('unregister removes the provider tool and deactivates the profile', () => {
    const ctx = track(setup());
    const service = ctx.get(IAgentUserToolService);
    const tools = ctx.resolve(AgentTools);
    service.register(toolA);
    service.unregister(toolA.name);
    expect(service.list()).toEqual([]);
    expect(tools.resolve(toolA.name)).toBeUndefined();
    expect(tools.isActive(toolA.name, 'user')).toBe(true);
  });

  it('inherits currently registered parent tools into an isolated child provider', () => {
    const parent = track(setup());
    const parentService = parent.get(IAgentUserToolService);
    parentService.register(toolA);
    parentService.register(toolB);
    parentService.unregister(toolB.name);
    const child = track(setup());
    child.get(IAgentUserToolService).inheritUserTools(parentService);
    expect(child.get(IAgentUserToolService).list()).toEqual([toolA]);
    expect(child.resolve(AgentTools).resolve(toolA.name)).toBeDefined();
    expect(child.resolve(AgentTools).resolve(toolB.name)).toBeUndefined();
    expect(parent.resolve(AgentTools).resolve(toolA.name)).toBeDefined();
  });

  it('inherits a registered tool without activating it when absent from active names', () => {
    const parent = track(setup());
    const parentService = parent.get(IAgentUserToolService);
    parentService.register(toolA);
    const child = track(createTestAgent());
    child.configure({ tools: [] });
    child.get(IAgentUserToolService).inheritUserTools(parentService, []);
    expect(child.resolve(AgentTools).resolve(toolA.name)).toBeDefined();
    expect(child.resolve(AgentTools).isActive(toolA.name, 'user')).toBe(true);
  });

  it('re-registering an equal tool preserves the service list value', () => {
    const ctx = track(setup());
    const service = ctx.get(IAgentUserToolService);
    service.register(toolA);
    const before = service.list();
    service.register(toolA);
    expect(service.list()).toEqual(before);
  });

  it('executes through the AgentTools provider and preserves the provider toolCallId', async () => {
    const ctx = track(setup());
    ctx.get(IAgentUserToolService).register(toolA);
    const execution = ctx.resolve(AgentTools).resolve(toolA.name)!.resolveExecution({ query: 'x' });
    expect(execution).toEqual(expect.objectContaining({ approvalRule: toolA.name }));
    if (!('execute' in execution)) throw new Error('expected runnable execution');
    const controller = new AbortController();
    const result = execution.execute({ turnId: 1, toolCallId: 'Bash_0', signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toThrow();
  });

  it('treats a disclosure change as a new provider snapshot', () => {
    const ctx = track(setup());
    const service = ctx.get(IAgentUserToolService);
    service.register(toolA);
    service.register({ ...toolA, disclosure: 'deferred' });
    expect(service.list()[0]).toEqual({ ...toolA, disclosure: 'deferred' });
    expect(ctx.resolve(AgentTools).availableTools().find((tool) => tool.name === toolA.name)?.disclosure).toBe('deferred');
  });

  it('restores provider tools with profile active semantics', async () => {
    const ctx = track(setup());
    const service = ctx.get(IAgentUserToolService);
    service.register(toolA);
    await ctx.restoreRuntimes();
    expect(ctx.resolve(AgentTools).resolve(toolA.name)).toBeDefined();
    expect(ctx.resolve(AgentTools).isActive(toolA.name, 'user')).toBe(true);
  });
});
