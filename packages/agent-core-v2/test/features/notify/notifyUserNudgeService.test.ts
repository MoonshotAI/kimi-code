import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IFlagService } from '#/app/flag/flag';
import { FlagService } from '#/app/flag/flagService';
import { NOTIFY_USER_FLAG_ID } from '#/features/notify/flag';
import { NOTIFY_USER_NUDGE_VARIANT } from '#/features/notify/notifyUserNudge';
import { NOTIFY_USER_TOOL_NAME } from '#/features/notify/tools/notify-user/notify-user';
import type { ExecutableTool } from '#/tool/toolContract';

import { runWillBeginStepHooks } from '../../agent/loop/stubs';
import { createTestAgent, type TestAgentContext } from '../../harness';

const notifyToolStub: ExecutableTool = {
  name: NOTIFY_USER_TOOL_NAME,
  description: 'stub',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  resolveExecution: () => ({
    approvalRule: NOTIFY_USER_TOOL_NAME,
    execute: async () => ({ output: 'ok' }),
  }),
};

function messageText(message: ContextMessage): string {
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

describe('AgentNotifyUserNudgeService', () => {
  let ctx: TestAgentContext;
  let context: IAgentContextMemoryService;
  let loop: IAgentLoopService;
  let flags: FlagService;

  function nudgeInjections(): readonly ContextMessage[] {
    return context
      .get()
      .filter(
        (message) =>
          message.origin?.kind === 'injection' && message.origin.variant === NOTIFY_USER_NUDGE_VARIANT,
      );
  }

  function appendSilentToolCalls(count: number): void {
    for (let index = 0; index < count; index += 1) {
      context.append({
        role: 'assistant',
        content: [],
        toolCalls: [
          { type: 'function', id: `call_${String(index)}`, name: 'Bash', arguments: '{}' },
        ],
      });
    }
  }

  beforeEach(async () => {
    ctx = createTestAgent({ autoConfigure: false });
    context = ctx.get(IAgentContextMemoryService);
    loop = ctx.get(IAgentLoopService);
    flags = ctx.get(IFlagService) as FlagService;
    flags.setConfigOverrides({ [NOTIFY_USER_FLAG_ID]: true });
    const registry = ctx.get(IAgentToolRegistryService);
    if (registry.resolve(NOTIFY_USER_TOOL_NAME) === undefined) registry.register(notifyToolStub);
    context.append({
      role: 'user',
      content: [{ type: 'text', text: 'do the thing' }],
      toolCalls: [],
      origin: { kind: 'user' },
    });
    await ctx.restorePersisted();
    ctx.configure();
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('stops injecting nudges when the flag is disabled mid-session', async () => {
    appendSilentToolCalls(8);
    await runWillBeginStepHooks(loop);
    expect(nudgeInjections()).toHaveLength(1);
    expect(messageText(nudgeInjections()[0]!)).toContain('NotifyUser');

    flags.setConfigOverrides({ [NOTIFY_USER_FLAG_ID]: false });
    appendSilentToolCalls(8);
    await runWillBeginStepHooks(loop);
    expect(nudgeInjections()).toHaveLength(1);

    flags.setConfigOverrides({ [NOTIFY_USER_FLAG_ID]: true });
    appendSilentToolCalls(8);
    await runWillBeginStepHooks(loop);
    expect(nudgeInjections()).toHaveLength(2);
  });
});
