import { describe, expect, it, onTestFinished } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { AgentPromptService } from '#/agent/prompt/promptService';
import type { PromptSubmitContext } from '#/agent/prompt/prompt';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { ToolDidExecuteContext } from '#/agent/tool/toolHooks';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentTurnService, type Turn } from '#/agent/turn/turn';

import { stubContextMemory } from '../contextMemory/stubs';
import { stubLoopWithHooks, stubToolExecutor, stubTurn } from '../turn/stubs';

function userMessage(text: string, origin: ContextMessage['origin']): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
    origin,
  };
}

function createHarness(options: { readonly hasActiveTurn?: boolean } = {}) {
  const disposables = new DisposableStore();
  onTestFinished(() => disposables.dispose());

  const context = stubContextMemory();
  const loop = stubLoopWithHooks();
  const turn = stubTurn({ hasActiveTurn: options.hasActiveTurn });
  const toolExecutor = stubToolExecutor();
  const ix = createServices(disposables, {
    strict: true,
    additionalServices: (reg) => {
      reg.defineInstance(IAgentContextMemoryService, context);
      reg.defineInstance(IAgentTurnService, turn);
      reg.defineInstance(IAgentLoopService, loop);
      reg.defineInstance(IAgentToolExecutorService, toolExecutor);
      reg.define(IAgentPromptService, AgentPromptService);
    },
  });

  return {
    context,
    loop,
    prompt: ix.get(IAgentPromptService),
    toolExecutor,
    turn,
  };
}

async function flushSteers(loop: IAgentLoopService, turn: Turn): Promise<void> {
  await loop.hooks.beforeStep.run({
    turnId: turn.id,
    step: 1,
    signal: turn.abortController.signal,
  });
}

describe('AgentPromptService', () => {
  it('delegates inactive steer to prompt', async () => {
    const { prompt, turn } = createHarness();
    const seen: Array<Pick<PromptSubmitContext, 'isSteer'> & {
      readonly originKind: string | undefined;
    }> = [];

    prompt.hooks.onWillSubmitPrompt.register('capture', async (ctx, next) => {
      seen.push({ isSteer: ctx.isSteer, originKind: ctx.promptMessage.origin?.kind });
      await next();
    });

    await prompt.prompt(userMessage('from prompt', { kind: 'system_trigger', name: 'test_prompt' }));
    const steer = prompt.steer(
      userMessage('from steer', { kind: 'system_trigger', name: 'test_steer' }),
    );
    await steer.launched;

    expect(seen).toEqual([
      { isSteer: false, originKind: 'system_trigger' },
      { isSteer: false, originKind: 'system_trigger' },
    ]);
    expect(turn.launches).toHaveLength(2);
    expect(() => steer.removeFromQueue()).toThrow(expect.objectContaining({
      code: 'request.invalid',
    }));
  });

  it('runs submit hooks before queuing active steers', async () => {
    const { context, loop, prompt, turn } = createHarness({ hasActiveTurn: true });
    const activeTurn = turn.launch();
    const seen: Array<Pick<PromptSubmitContext, 'isSteer'> & {
      readonly originKind: string | undefined;
    }> = [];

    prompt.hooks.onWillSubmitPrompt.register('capture', async (ctx, next) => {
      seen.push({ isSteer: ctx.isSteer, originKind: ctx.promptMessage.origin?.kind });
      await next();
    });

    const removed = prompt.steer(
      userMessage('removed', { kind: 'system_trigger', name: 'test_removed' }),
    );
    await expect(removed.launched).resolves.toBe(activeTurn);
    removed.removeFromQueue();
    await flushSteers(loop, activeTurn);
    expect(context.messages).toEqual([]);
    expect(turn.steered).toEqual([]);

    const emitted = prompt.steer(
      userMessage('emitted', { kind: 'system_trigger', name: 'test_emitted' }),
    );
    await expect(emitted.launched).resolves.toBe(activeTurn);
    await flushSteers(loop, activeTurn);

    expect(seen).toEqual([
      { isSteer: true, originKind: 'system_trigger' },
      { isSteer: true, originKind: 'system_trigger' },
    ]);
    expect(context.messages.map((message) => message.content[0])).toMatchObject([
      { type: 'text', text: 'emitted' },
    ]);
    expect(turn.steered).toHaveLength(1);
    expect(turn.steered[0]?.input).toMatchObject([{ type: 'text', text: 'emitted' }]);
    expect(turn.steered[0]?.origin).toMatchObject({
      kind: 'system_trigger',
      name: 'test_emitted',
    });
    expect(() => emitted.removeFromQueue()).toThrow(expect.objectContaining({
      code: 'request.invalid',
    }));
  });

  it('does not queue active steers blocked by hooks', async () => {
    const { context, loop, prompt, turn } = createHarness({ hasActiveTurn: true });
    const activeTurn = turn.launch();

    prompt.hooks.onWillSubmitPrompt.register('block', async (ctx) => {
      ctx.block = true;
    });

    const steer = prompt.steer(
      userMessage('blocked steer', { kind: 'system_trigger', name: 'test_block_steer' }),
    );

    await expect(steer.launched).resolves.toBeUndefined();
    await flushSteers(loop, activeTurn);
    expect(context.messages).toEqual([]);
  });

  it('blocks launch when the hook sets block', async () => {
    const { context, prompt, turn } = createHarness();

    prompt.hooks.onWillSubmitPrompt.register('block', async (ctx) => {
      ctx.block = true;
    });

    const result = await prompt.prompt(
      userMessage('blocked', { kind: 'system_trigger', name: 'test_block' }),
    );

    expect(result).toBeUndefined();
    expect(turn.launches).toEqual([]);
    expect(context.messages).toHaveLength(1);
  });

  it('delivers a declared steer through onDidExecuteTool and strips delivery', async () => {
    const { context, loop, turn, toolExecutor } = createHarness({ hasActiveTurn: true });
    const activeTurn = turn.launch();

    const origin = {
      kind: 'skill_activation',
      activationId: 'a1',
      skillName: 'commit',
      trigger: 'model-tool',
    } as const;
    const didCtx: ToolDidExecuteContext = {
      turnId: activeTurn.id,
      signal: activeTurn.abortController.signal,
      toolCall: { type: 'function', id: 'call_skill', name: 'Skill', arguments: '{}' },
      toolCalls: [],
      args: {},
      result: {
        output: 'ack',
        delivery: {
          kind: 'steer',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'injected skill body' }],
            toolCalls: [],
            origin,
          },
        },
      },
    };

    await toolExecutor.hooks.onDidExecuteTool.run(didCtx);

    // The hook consumes the side channel so it never reaches the loop/persistence.
    expect(didCtx.result.delivery).toBeUndefined();

    await flushSteers(loop, activeTurn);
    expect(context.messages.map((message) => message.content[0])).toMatchObject([
      { type: 'text', text: 'injected skill body' },
    ]);
    expect(context.messages[0]?.origin).toMatchObject({
      kind: 'skill_activation',
      skillName: 'commit',
    });
  });
});
