import { describe, expect, it, onTestFinished } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { buildImageCompressionCaption } from '#/_base/tools/support/image-compress';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { AgentPromptService } from '#/agent/prompt/promptService';
import type { PromptSubmitContext } from '#/agent/prompt/prompt';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { AgentSystemReminderService } from '#/agent/systemReminder/systemReminderService';
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
      reg.define(IAgentSystemReminderService, AgentSystemReminderService);
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

  it('launches the turn before appending the user message', async () => {
    const { context, prompt, turn } = createHarness();
    const events: string[] = [];
    const originalLaunch = turn.launch.bind(turn);
    turn.launch = (...args) => {
      events.push('turn.launch');
      return originalLaunch(...args);
    };
    const originalAppend = context.append.bind(context);
    context.append = (...messages) => {
      events.push('context.append');
      originalAppend(...messages);
    };

    await prompt.prompt(userMessage('ordered', { kind: 'user' }));

    expect(events).toEqual(['turn.launch', 'context.append']);
    expect(turn.launches).toEqual([0]);
    expect(context.messages.map((message) => message.content[0])).toMatchObject([
      { type: 'text', text: 'ordered' },
    ]);
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
    expect(context.messages).toMatchObject([
      {
        content: [{ type: 'text', text: 'blocked' }],
        origin: { kind: 'system_trigger', name: 'test_block' },
      },
    ]);
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

  describe('image-compression caption rerouting', () => {
    const CAPTION = buildImageCompressionCaption({
      original: { width: 3264, height: 666, byteLength: 344 * 1024, mimeType: 'image/png' },
      final: { width: 2000, height: 408, byteLength: 282 * 1024, mimeType: 'image/png' },
      originalPath: '/tmp/originals/shot.png',
    });

    const textOf = (message: ContextMessage): string =>
      message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');

    it('reroutes an inline caption into a hidden system reminder', async () => {
      const { context, prompt } = createHarness();

      // The TUI merges the caption into the preceding text segment; the server
      // route emits it as a standalone part. Cover the merged (harder) shape.
      await prompt.prompt({
        role: 'user',
        content: [
          { type: 'text', text: `能展示但是没有快捷键提示${CAPTION}` },
          { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
        ],
        toolCalls: [],
        origin: { kind: 'user' },
      });

      expect(context.messages.map(({ role, origin }) => ({ role, origin }))).toEqual([
        { role: 'user', origin: { kind: 'injection', variant: 'image_compression' } },
        { role: 'user', origin: { kind: 'user' } },
      ]);
      const [reminder, userMsg] = context.messages;
      expect(textOf(reminder!)).toContain('<system-reminder>');
      expect(textOf(reminder!)).toContain('Image compressed to fit model limits');
      expect(textOf(reminder!)).toContain('/tmp/originals/shot.png');
      expect(textOf(reminder!)).not.toContain('<system>');
      expect(textOf(userMsg!)).toBe('能展示但是没有快捷键提示');
      expect(userMsg!.content.some((part) => part.type === 'image_url')).toBe(true);
    });

    it('drops a caption-only text part instead of leaving an empty user text part', async () => {
      const { context, prompt } = createHarness();

      await prompt.prompt({
        role: 'user',
        content: [
          { type: 'text', text: CAPTION },
          { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
        ],
        toolCalls: [],
        origin: { kind: 'user' },
      });

      const [, userMsg] = context.messages;
      expect(userMsg!.content).toEqual([
        { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
      ]);
    });

    it('leaves caption-shaped text alone on non-user origins', async () => {
      const { context, prompt } = createHarness();

      await prompt.prompt({
        role: 'user',
        content: [{ type: 'text', text: CAPTION }],
        toolCalls: [],
        origin: { kind: 'hook_result', event: 'PostToolUse' },
      });

      expect(context.messages).toHaveLength(1);
      expect(context.messages[0]!.origin).toEqual({
        kind: 'hook_result',
        event: 'PostToolUse',
      });
      expect(textOf(context.messages[0]!)).toBe(CAPTION);
    });

    it('reroutes captions in steered user messages at flush time', async () => {
      const { context, loop, prompt, turn } = createHarness({ hasActiveTurn: true });
      const activeTurn = turn.launch();

      const steer = prompt.steer({
        role: 'user',
        content: [
          { type: 'text', text: `看这张图${CAPTION}` },
          { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
        ],
        toolCalls: [],
        origin: { kind: 'user' },
      });
      await steer.launched;
      // Nothing lands in context until the steer flushes at the step boundary.
      expect(context.messages).toEqual([]);

      await flushSteers(loop, activeTurn);

      expect(context.messages.map(({ role, origin }) => ({ role, origin }))).toEqual([
        { role: 'user', origin: { kind: 'injection', variant: 'image_compression' } },
        { role: 'user', origin: { kind: 'user' } },
      ]);
      expect(textOf(context.messages[1]!)).toBe('看这张图');
      expect(turn.steered).toHaveLength(1);
      expect(turn.steered[0]?.input).toMatchObject([
        { type: 'text', text: '看这张图' },
        { type: 'image_url' },
      ]);
    });
  });
});
