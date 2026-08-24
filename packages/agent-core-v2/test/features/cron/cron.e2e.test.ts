import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentCron, type CronRuntime } from '#/features/cron/cronAgentRuntime';
import type { CronConfig } from '#/features/cron/configSection';
import type { ExecutableToolOutput, ToolExecution } from '#/tool/toolContract';

import { createTestAgent, type TestAgentContext } from '../../harness';

const LOCAL_ANCHOR_MS = new Date(2024, 5, 1, 12, 0, 0, 0).getTime();

function isRunnable(
  execution: ToolExecution,
): execution is Extract<ToolExecution, { execute: unknown }> {
  return 'execute' in execution;
}

function outputText(out: ExecutableToolOutput): string {
  return typeof out === 'string' ? out : JSON.stringify(out);
}

describe('Cron — session E2E', () => {
  let ctx: TestAgentContext;
  let cron: CronRuntime;
  let prompt: IAgentPromptService;
  let clockFile: string;

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-cron-e2e-'));
    clockFile = join(dir, 'clock.txt');
    writeFileSync(clockFile, String(LOCAL_ANCHOR_MS));

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
    cron = ctx.resolve(AgentCron);
    prompt = ctx.get(IAgentPromptService);
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
      vi.restoreAllMocks();
    }
  });

  it('recurring */5 task advances 15min → exactly one steer with coalescedCount=3', async () => {
    const steerCalls: Array<{
      readonly content: readonly unknown[];
      readonly origin: unknown;
    }> = [];
    vi.spyOn(prompt, 'inject').mockImplementation(async (message: ContextMessage) => {
      steerCalls.push({ content: message.content, origin: message.origin });
      return undefined;
    });

    const createTool = ctx.get(IAgentToolRegistryService).resolve('CronCreate');
    expect(createTool).toBeDefined();
    const execution = await createTool!.resolveExecution({
      cron: '*/5 * * * *',
      prompt: 'cron-fired prompt',
      recurring: true,
    });
    if (!isRunnable(execution)) {
      throw new Error(
        `CronCreate unexpectedly errored: ${'output' in execution ? outputText(execution.output) : ''}`,
      );
    }
    const createResult = await execution.execute({
      turnId: 19,
      toolCallId: 'p19-call',
      signal: new AbortController().signal,
    });
    expect(createResult.isError ?? false).toBe(false);
    expect(cron.list().length).toBe(1);

    writeFileSync(clockFile, String(LOCAL_ANCHOR_MS + 15 * 60_000));
    await cron.tick();

    expect(steerCalls.length).toBe(1);
    const fire = steerCalls[0]!;

    expect(fire.content).toHaveLength(1);
    const fireText = (fire.content[0] as { type: 'text'; text: string }).text;
    expect(fireText).toContain('<cron-fire ');
    expect(fireText).toContain('cron-fired prompt');

    expect(fire.origin).toMatchObject({
      kind: 'cron_job',
      cron: '*/5 * * * *',
      recurring: true,
      coalescedCount: 3,
      stale: false,
    });
    const origin = fire.origin as { readonly jobId: string };
    expect(typeof origin.jobId).toBe('string');
    expect(origin.jobId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/i);
  });

  it('CronCreate → CronList → CronDelete cycle returns sensible output', async () => {
    const registry = ctx.get(IAgentToolRegistryService);
    const createTool = registry.resolve('CronCreate');
    const listTool = registry.resolve('CronList');
    const deleteTool = registry.resolve('CronDelete');
    expect(createTool).toBeDefined();
    expect(listTool).toBeDefined();
    expect(deleteTool).toBeDefined();
    const ctxArgs = {
      turnId: 19,
      toolCallId: 'p19-tools-call',
      signal: new AbortController().signal,
    };

    const createExec = await createTool!.resolveExecution({
      cron: '*/10 * * * *',
      prompt: 'noop',
      recurring: true,
    });
    if (!isRunnable(createExec)) {
      throw new Error('CronCreate failed to produce a runnable execution');
    }
    const createOut = await createExec.execute(ctxArgs);
    expect(createOut.isError ?? false).toBe(false);
    const idMatch = /id:\s*(\S+)/.exec(outputText(createOut.output));
    expect(idMatch).not.toBeNull();
    const id = idMatch![1]!;

    const listExec = await listTool!.resolveExecution({});
    if (!isRunnable(listExec)) {
      throw new Error('CronList failed to produce a runnable execution');
    }
    const listOut = await listExec.execute(ctxArgs);
    expect(listOut.isError ?? false).toBe(false);
    const listText = outputText(listOut.output);
    expect(listText).toContain('cron_jobs: 1');
    expect(listText).toContain(`id: ${id}`);
    expect(listText).toContain('cron: */10 * * * *');

    const deleteExec = await deleteTool!.resolveExecution({ id });
    if (!isRunnable(deleteExec)) {
      throw new Error('CronDelete failed to produce a runnable execution');
    }
    const deleteOut = await deleteExec.execute(ctxArgs);
    expect(deleteOut.isError ?? false).toBe(false);
    expect(outputText(deleteOut.output)).toContain(`Deleted cron job ${id}`);

    const listExec2 = await listTool!.resolveExecution({});
    if (!isRunnable(listExec2)) {
      throw new Error('CronList failed to produce a runnable execution');
    }
    const listOut2 = await listExec2.execute(ctxArgs);
    expect(listOut2.isError ?? false).toBe(false);
    expect(outputText(listOut2.output)).toContain('cron_jobs: 0');
    expect(outputText(listOut2.output)).toContain('No cron jobs scheduled.');
  });
});
