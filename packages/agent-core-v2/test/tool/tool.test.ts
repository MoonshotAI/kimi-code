import { describe, expect, it } from 'vitest';

import type { ToolCallResult, ToolDefinition } from '#/tool/tool';
import { ToolDefinitionRegistry, ToolService } from '#/tool/toolService';

const echoDef: ToolDefinition = {
  name: 'echo',
  factory: () => ({
    execute: (args: unknown): Promise<ToolCallResult> =>
      Promise.resolve({ output: JSON.stringify(args) }),
  }),
};

describe('ToolDefinitionRegistry', () => {
  it('registers and retrieves definitions', () => {
    const reg = new ToolDefinitionRegistry();
    reg.register(echoDef);
    expect(reg.get('echo')).toBe(echoDef);
    expect(reg.get('missing')).toBeUndefined();
    expect(reg.list()).toEqual([echoDef]);
  });
});

describe('ToolService', () => {
  function make(): { svc: ToolService; reg: ToolDefinitionRegistry } {
    const reg = new ToolDefinitionRegistry();
    reg.register(echoDef);
    const svc = new ToolService(
      reg,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );
    return { svc, reg };
  }

  it('executes a builtin tool from the registry', async () => {
    const { svc } = make();
    const result = await svc.execute('echo', { msg: 'hi' });
    expect(result).toEqual({ output: '{"msg":"hi"}' });
  });

  it('routes a user-registered tool', async () => {
    const { svc } = make();
    const userDef: ToolDefinition = {
      name: 'user-tool',
      factory: () => ({ execute: (): Promise<ToolCallResult> => Promise.resolve({ output: 'user' }) }),
    };
    svc.registerUserTool(userDef);
    expect(await svc.execute('user-tool', {})).toEqual({ output: 'user' });
  });

  it('throws on unknown tool', async () => {
    const { svc } = make();
    await expect(svc.execute('nope', {})).rejects.toThrow(/unknown tool/);
  });

  it('list aggregates builtin + user + mcp', () => {
    const { svc } = make();
    svc.registerUserTool({ name: 'u', factory: () => ({ execute: () => Promise.resolve({ output: '' }) }) });
    svc.registerMcpTools('srv', [{ name: 'm', factory: () => ({ execute: () => Promise.resolve({ output: '' }) }) }]);
    expect(svc.list().map((d) => d.name).sort()).toEqual(['echo', 'm', 'u']);
  });
});
