import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import type { ExecutableTool, ToolExecution } from '#/tool/toolContract';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';

class StubTool implements ExecutableTool<unknown> {
  readonly parameters = { type: 'object', additionalProperties: true };

  constructor(
    readonly name: string,
    readonly description: string = 'stub tool',
  ) {}

  resolveExecution(): ToolExecution {
    return {
      approvalRule: this.name,
      execute: async () => ({ output: `${this.name} result` }),
    };
  }
}

let disposables: DisposableStore;
let ix: TestInstantiationService;
let registry: IAgentToolRegistryService;

beforeEach(() => {
  disposables = new DisposableStore();
  ix = createServices(disposables, {
    additionalServices: (reg) => {
      reg.define(IAgentToolRegistryService, AgentToolRegistryService);
    },
    strict: true,
  });
  registry = ix.get(IAgentToolRegistryService);
});

afterEach(() => {
  disposables.dispose();
});

describe('AgentToolRegistryService', () => {
  it('resolves a registered tool by name', () => {
    const tool = new StubTool('Bash');
    registry.register(tool);

    const resolved = registry.resolve('Bash');
    expect(resolved).toBe(tool);
  });

  it('returns undefined for unknown tool names', () => {
    expect(registry.resolve('NonExistent')).toBeUndefined();
  });

  it('lists registered tools sorted by name', () => {
    registry.register(new StubTool('Zebra'));
    registry.register(new StubTool('Apple'));
    registry.register(new StubTool('Mango'));

    const list = registry.list();
    expect(list.map((t) => t.name)).toEqual(['Apple', 'Mango', 'Zebra']);
  });

  it('includes source metadata in the listing', () => {
    const builtin = new StubTool('Builtin');
    const user = new StubTool('User');
    const mcp = new StubTool('Mcp');

    registry.register(builtin, { source: 'builtin' });
    registry.register(user, { source: 'user' });
    registry.register(mcp, { source: 'mcp' });

    const list = registry.list();
    expect(list.find((t) => t.name === 'Builtin')?.source).toBe('builtin');
    expect(list.find((t) => t.name === 'User')?.source).toBe('user');
    expect(list.find((t) => t.name === 'Mcp')?.source).toBe('mcp');
  });

  it('defaults to "builtin" source when none specified', () => {
    registry.register(new StubTool('Default'));
    const list = registry.list();
    expect(list.find((t) => t.name === 'Default')?.source).toBe('builtin');
  });

  it('unregisters a tool when the IDisposable is disposed', () => {
    const tool = new StubTool('Temp');
    const handle = registry.register(tool);

    expect(registry.resolve('Temp')).toBe(tool);

    handle.dispose();
    expect(registry.resolve('Temp')).toBeUndefined();
  });

  it('replaces an existing tool when re-registering the same name', () => {
    const original = new StubTool('Echo', 'original');
    const replacement = new StubTool('Echo', 'replacement');

    registry.register(original);
    expect(registry.resolve('Echo')).toBe(original);

    registry.register(replacement);
    expect(registry.resolve('Echo')).toBe(replacement);
  });

  it('does not unregister a replacement when the original disposable fires', () => {
    const original = new StubTool('Echo', 'original');
    const replacement = new StubTool('Echo', 'replacement');

    const originalHandle = registry.register(original);
    registry.register(replacement);

    originalHandle.dispose();
    expect(registry.resolve('Echo')).toBe(replacement);
  });

  it('lists tool info with description and parameters', () => {
    const tool = new StubTool('Search');
    tool.description = 'Search files';
    registry.register(tool);

    const info = registry.list().find((t) => t.name === 'Search');
    expect(info).toBeDefined();
    expect(info?.description).toBe('Search files');
    expect(info?.parameters).toEqual({ type: 'object', additionalProperties: true });
  });

  it('registering a tool with an empty name does not crash', () => {
    expect(() => {
      registry.register(new StubTool(''));
    }).not.toThrow();
  });

  it('disposing a registration handle twice is safe', () => {
    const tool = new StubTool('DoubleDispose');
    const handle = registry.register(tool);
    handle.dispose();
    handle.dispose();
    expect(registry.resolve('DoubleDispose')).toBeUndefined();
  });

  it('registering the same tool instance twice does not throw', () => {
    const tool = new StubTool('Dupe');
    registry.register(tool);
    expect(() => {
      registry.register(tool);
    }).not.toThrow();
  });

  it('list returns an empty array when no tools are registered', () => {
    expect(registry.list()).toEqual([]);
  });

  it('calling unregister on a disposable handle from a replaced registration is safe', () => {
    const original = new StubTool('A', 'original');
    const replacement = new StubTool('A', 'replacement');

    const originalHandle = registry.register(original);
    const replacementHandle = registry.register(replacement);

    originalHandle.dispose();
    expect(registry.resolve('A')).toBe(replacement);

    replacementHandle.dispose();
    expect(registry.resolve('A')).toBeUndefined();
  });
});
