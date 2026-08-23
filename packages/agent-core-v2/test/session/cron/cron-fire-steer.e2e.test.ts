import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import type { CronConfig } from '#/app/cron/configSection';
import { AgentCron } from '#/session/cron/cronAgentRuntime';

import { createTestAgent, type TestAgentContext } from '../../harness';

function textOf(message: ContextMessage): string {
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

describe('cron-fired steer turn context', () => {
  let ctx: TestAgentContext;
  let clockFile: string;

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cron-steer-'));
    clockFile = join(dir, 'clock.txt');
    writeFileSync(clockFile, String(Date.now()));

    ctx = createTestAgent();

    const cronConfig: CronConfig = {
      debug: false,
      noJitter: true,
      noStale: false,
      disabled: false,
      manualTick: true,
      clock: `file:${clockFile}`,
    };
    ctx.kimiConfig = { ...ctx.kimiConfig, cron: cronConfig };
    await ctx.restorePersisted();

    await ctx.rpc.setPermission({ mode: 'yolo' });
  });

  afterEach(async () => {
    await ctx.dispose();
  });

  it('carries earlier tool results into the cron-fired steer turn request', async () => {
    ctx.mockNextResponse({
      type: 'function',
      id: 'call_cron_1',
      name: 'CronCreate',
      arguments: JSON.stringify({ cron: '* * * * *', prompt: 'fire me', recurring: true }),
    });
    ctx.mockNextResponse({ type: 'text', text: 'scheduled' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'remind me every minute' }] });
    await ctx.untilTurnEnd();

    const toolMessages = ctx.contextData().history.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(1);
    const jobId = textOf(toolMessages[0]!).match(/^id: (\S+)$/m)?.[1];
    expect(jobId).toBeDefined();

    ctx.mockNextResponse({ type: 'text', text: 'cron turn done' });
    writeFileSync(clockFile, String(Date.now() + 120_000));
    await ctx.resolve(AgentCron).tick();
    await ctx.get(IAgentLoopService).settled();

    expect(ctx.llmCalls.length).toBe(3);
    const fireRequest = ctx.llmCalls.at(-1)!;

    const lastUser = fireRequest.history.filter((m) => m.role === 'user').at(-1);
    const lastUserText = lastUser?.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('') ?? '';
    expect(lastUserText).toContain('fire me');

    const requestToolTexts = fireRequest.history
      .filter((m) => m.role === 'tool')
      .flatMap((m) => m.content)
      .map((part) => (part.type === 'text' ? part.text : ''));
    expect(requestToolTexts.some((text) => text.includes(`id: ${jobId!}`))).toBe(true);
  });
});
