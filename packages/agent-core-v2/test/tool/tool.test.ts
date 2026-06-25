import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentConfigService } from '#/config/config';
import { IAgentKaos } from '#/kaos/kaos';
import { ILLMService } from '#/kosong/kosong';
import { IPermissionService } from '#/permission/permission';
import { IAgentRecords } from '#/records/records';
import { IToolDefinitionRegistry, type ToolCallResult, type ToolDefinition } from '#/tool/tool';
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
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let reg: ToolDefinitionRegistry;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    reg = new ToolDefinitionRegistry();
    reg.register(echoDef);
    ix.set(IToolDefinitionRegistry, reg);
    ix.stub(IAgentConfigService, {});
    ix.stub(IAgentRecords, {});
    ix.stub(IAgentKaos, {});
    ix.stub(IPermissionService, {});
    ix.stub(ILLMService, {});
  });
  afterEach(() => disposables.dispose());

  function make(): { svc: ToolService; reg: ToolDefinitionRegistry } {
    const svc = ix.createInstance(ToolService);
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
