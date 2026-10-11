import { afterEach, describe, expect, it } from 'vitest';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { type HostUiCapability, IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import { FlagService } from '#/app/flag/flagService';
import { NOTIFY_USER_FLAG_ID } from '#/features/notify/flag';
import { NOTIFY_USER_UI_CAPABILITY } from '#/features/notify/notifyUserAvailability';
import { NOTIFY_USER_NUDGE_VARIANT } from '#/features/notify/notifyUserNudge';
import { NOTIFY_USER_TOOL_NAME } from '#/features/notify/tools/notify-user/notify-user';
import type { ExecutableTool } from '#/tool/toolContract';

import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';
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
  let telemetry: TelemetryRecord[];

  function nudgeInjections(): readonly ContextMessage[] {
    return context
      .get()
      .filter(
        (message) =>
          message.origin?.kind === 'injection' && message.origin.variant === NOTIFY_USER_NUDGE_VARIANT,
      );
  }

  function appendSilentRounds(count: number): void {
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

  async function start(uiCapabilities: readonly HostUiCapability[]): Promise<void> {
    telemetry = [];
    ctx = createTestAgent({ autoConfigure: false, telemetry: recordingTelemetry(telemetry) });
    Object.assign(ctx.get(IBootstrapService).args, { uiCapabilities });
    context = ctx.get(IAgentContextMemoryService);
    loop = ctx.get(IAgentLoopService);
    flags = ctx.get(IFlagService) as FlagService;
    flags.setConfigOverrides({ [NOTIFY_USER_FLAG_ID]: true });
    const registry = ctx.get(IAgentToolRegistryService);
    if (registry.resolve(NOTIFY_USER_TOOL_NAME) === undefined) registry.register(notifyToolStub);
    await ctx.restorePersisted();
    context.append({
      role: 'user',
      content: [{ type: 'text', text: 'do the thing' }],
      toolCalls: [],
      origin: { kind: 'user' },
    });
    ctx.configure();
  }

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('stops injecting nudges when the flag is disabled mid-session', async () => {
    await start([NOTIFY_USER_UI_CAPABILITY]);
    appendSilentRounds(8);
    await runWillBeginStepHooks(loop);
    expect(nudgeInjections()).toHaveLength(1);
    expect(messageText(nudgeInjections()[0]!)).toContain('NotifyUser');

    flags.setConfigOverrides({ [NOTIFY_USER_FLAG_ID]: false });
    appendSilentRounds(8);
    await runWillBeginStepHooks(loop);
    expect(nudgeInjections()).toHaveLength(1);

    flags.setConfigOverrides({ [NOTIFY_USER_FLAG_ID]: true });
    appendSilentRounds(8);
    await runWillBeginStepHooks(loop);
    expect(nudgeInjections()).toHaveLength(2);
  });

  it('tracks each injected nudge with its position in the silent stretch', async () => {
    await start([NOTIFY_USER_UI_CAPABILITY]);
    appendSilentRounds(8);
    await runWillBeginStepHooks(loop);
    appendSilentRounds(8);
    await runWillBeginStepHooks(loop);

    const shown = telemetry.filter((record) => record.event === 'notify_user_nudge_shown');
    expect(shown.map((record) => record.properties)).toEqual([
      expect.objectContaining({ rounds_since_notify: 8, nudge_index: 1 }),
      expect.objectContaining({ rounds_since_notify: 16, nudge_index: 2 }),
    ]);
  });

  it('counts a step of parallel tool calls as a single round', async () => {
    await start([NOTIFY_USER_UI_CAPABILITY]);
    context.append({
      role: 'assistant',
      content: [],
      toolCalls: Array.from({ length: 8 }, (_, index) => ({
        type: 'function' as const,
        id: `call_parallel_${String(index)}`,
        name: 'Read',
        arguments: '{}',
      })),
    });
    await runWillBeginStepHooks(loop);
    expect(nudgeInjections()).toHaveLength(0);

    appendSilentRounds(7);
    await runWillBeginStepHooks(loop);
    expect(nudgeInjections()).toHaveLength(1);
    expect(messageText(nudgeInjections()[0]!)).toContain('8 rounds of tool calls');
  });

  it('does not nudge on mid-turn text before the round threshold', async () => {
    await start([NOTIFY_USER_UI_CAPABILITY]);
    context.append({
      role: 'assistant',
      content: [{ type: 'text', text: 'Checking the parser first.' }],
      toolCalls: [{ type: 'function', id: 'call_mid', name: 'Bash', arguments: '{}' }],
    });
    await runWillBeginStepHooks(loop);
    expect(nudgeInjections()).toHaveLength(0);
  });

  it('does not inject nudges in a host without the update panel', async () => {
    await start([]);
    appendSilentRounds(8);
    await runWillBeginStepHooks(loop);
    expect(nudgeInjections()).toHaveLength(0);
    expect(telemetry.filter((record) => record.event === 'notify_user_nudge_shown')).toHaveLength(0);

    context.append({
      role: 'assistant',
      content: [{ type: 'text', text: 'Halfway through the checks.' }],
      toolCalls: [{ type: 'function', id: 'call_mid', name: 'Bash', arguments: '{}' }],
    });
    await runWillBeginStepHooks(loop);
    expect(nudgeInjections()).toHaveLength(0);
  });
});
