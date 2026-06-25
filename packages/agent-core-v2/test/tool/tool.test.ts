import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import type { TestInstantiationService } from '#/_base/di/test';
import { IKaosService } from '#/kaos/kaos';
import {
  IToolDefinitionRegistry,
  IToolService,
  type ToolCallResult,
  type ToolDefinition,
} from '#/tool/tool';
import { ToolDefinitionRegistry, ToolService } from '#/tool/toolService';
import { registerConfigServices } from '../config/stubs';
import { registerKosongServices } from '../kosong/stubs';
import { registerPermissionServices } from '../permission/stubs';
import { registerRecordsServices } from '../records/stubs';

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
    reg = new ToolDefinitionRegistry();
    reg.register(echoDef);
    ix = createServices(disposables, {
      base: [
        registerConfigServices,
        registerRecordsServices,
        registerPermissionServices,
        registerKosongServices,
      ],
      additionalServices: (r) => {
        r.defineInstance(IToolDefinitionRegistry, reg);
        r.definePartialInstance(IKaosService, {});
        r.define(IToolService, ToolService);
      },
    });
  });
  afterEach(() => disposables.dispose());

  function make(): { svc: IToolService; reg: ToolDefinitionRegistry } {
    const svc = ix.get(IToolService);
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
