import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import type { TestInstantiationService } from '#/_base/di/test';
import { type Decision, IPermissionService, type PermissionContext } from '#/permission/permission';
import { type ToolCallResult, type ToolDefinition, IToolService } from '#/tool/tool';
import { ITurnContext, ITurnEvents } from '#/turn/turn';

import { TurnEvents } from '#/turn/turnEvents';
import { ToolCallExecutor } from '#/turn/toolCallExecutor';
import { registerLogServices } from '../log/stubs';

describe('ToolCallExecutor', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let turnEvents: TurnEvents;
  let executed: string[];
  let decision: Decision;
  let permission: IPermissionService;

  function toolService(): IToolService {
    return {
      _serviceBrand: undefined,
      execute: (name: string): Promise<ToolCallResult> => {
        executed.push(name);
        return Promise.resolve({ output: `ran:${name}` });
      },
      list: (): readonly ToolDefinition[] => [],
      registerUserTool: () => {},
      registerMcpTools: () => {},
    };
  }

  function permissionService(): IPermissionService {
    return {
      _serviceBrand: undefined,
      beforeToolCall: (_ctx: PermissionContext): Promise<Decision> => Promise.resolve(decision),
    };
  }

  beforeEach(() => {
    disposables = new DisposableStore();
    executed = [];
    decision = 'allow';
    permission = permissionService();
    turnEvents = new TurnEvents();
    ix = createServices(disposables, {
      base: [registerLogServices],
      additionalServices: (reg) => {
        reg.defineInstance(ITurnEvents, turnEvents);
        reg.defineInstance(IToolService, toolService());
        reg.definePartialInstance(ITurnContext, { turnId: 'turn-0' });
      },
    });

    turnEvents.onWillExecuteTool((event) => {
      event.veto(
        Promise.resolve(
          permission.beforeToolCall({ toolName: event.toolName, args: event.args }),
        ).then((value) => value === 'deny'),
        'permission',
      );
    });
  });
  afterEach(() => disposables.dispose());

  it('runs the tool and fires onDidFinalizeTool when permission allows', async () => {
    const executor = ix.createInstance(ToolCallExecutor);
    const finalized: string[] = [];
    turnEvents.onDidFinalizeTool((e) => finalized.push(e.toolName));

    const outcome = await executor.execute('call-1', 'echo', { text: 'hi' });

    expect(outcome).toEqual({ vetoed: false, result: { output: 'ran:echo' } });
    expect(executed).toEqual(['echo']);
    expect(finalized).toEqual(['echo']);
  });

  it('vetoes the tool call when permission denies, skipping execution', async () => {
    decision = 'deny';
    permission = permissionService();
    const executor = ix.createInstance(ToolCallExecutor);
    const finalized: string[] = [];
    turnEvents.onDidFinalizeTool((e) => finalized.push(e.toolName));

    const outcome = await executor.execute('call-1', 'rm', {});

    expect(outcome.vetoed).toBe(true);
    if (outcome.vetoed) {
      expect(outcome.reason).toBe('permission');
    }
    expect(executed).toEqual([]);
    expect(finalized).toEqual([]);
  });

  it('awaits an asynchronous permission decision before vetoing', async () => {
    permission = {
      _serviceBrand: undefined,
      beforeToolCall: (): Promise<Decision> =>
        new Promise((resolve) => setTimeout(() => resolve('deny'), 10)),
    };
    const executor = ix.createInstance(ToolCallExecutor);

    const outcome = await executor.execute('call-1', 'rm', {});

    expect(outcome.vetoed).toBe(true);
    expect(executed).toEqual([]);
  });

  it('lets an external onWillExecuteTool listener veto the call', async () => {
    const executor = ix.createInstance(ToolCallExecutor);
    turnEvents.onWillExecuteTool((e) => {
      e.veto(true, 'manual block');
    });

    const outcome = await executor.execute('call-1', 'echo', {});

    expect(outcome).toEqual({ vetoed: true, reason: 'manual block' });
    expect(executed).toEqual([]);
  });

  it('delivers tool name and args to onWillExecuteTool listeners', async () => {
    const executor = ix.createInstance(ToolCallExecutor);
    const seen: { toolName: string; args: unknown }[] = [];
    turnEvents.onWillExecuteTool((e) => {
      seen.push({ toolName: e.toolName, args: e.args });
    });

    await executor.execute('call-1', 'echo', { text: 'hi' });

    expect(seen).toEqual([{ toolName: 'echo', args: { text: 'hi' } }]);
  });
});
