import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CronCreateTool } from '#/agent/tools/cron/cron-create/cronCreateTool';
import { CronDeleteTool } from '#/agent/tools/cron/cron-delete/cronDeleteTool';
import { CronListTool } from '#/agent/tools/cron/cron-list/cronListTool';
import type { ExecutableToolOutput } from '#/tool/toolContract';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { ISessionCronService } from '#/session/cron/sessionCronService';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { createTestAgent, cronServices, type TestAgentContext } from '../../harness';

const LOCAL_ANCHOR_MS = new Date(2024, 5, 1, 12, 0, 0, 0).getTime();

const scopeContext = makeAgentScopeContext({ agentId: 'main', agentScope: '' });

function createClocks(initial = LOCAL_ANCHOR_MS) {
  let wall = initial;
  vi.spyOn(Date, 'now').mockImplementation(() => wall);
  return {
    advance(ms: number) {
      wall += ms;
    },
  };
}

function outputText(out: ExecutableToolOutput): string {
  return typeof out === 'string' ? out : JSON.stringify(out);
}

describe('Cron — session E2E (P1.9)', () => {
  let ctx: TestAgentContext;
  let cron: ISessionCronService;
  let prompt: IAgentPromptService;
  let harness: ReturnType<typeof createClocks>;

  beforeEach(async () => {
    vi.stubEnv('KIMI_CRON_NO_JITTER', '1');
    vi.stubEnv('KIMI_CRON_POLL_INTERVAL_MS', '0');
    harness = createClocks();
    ctx = createTestAgent(cronServices());
    ctx.announceMain();
    cron = ctx.get(ISessionCronService);
    prompt = ctx.get(IAgentPromptService);
    await cron.start();
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
      vi.unstubAllEnvs();
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

    const createTool = new CronCreateTool(cron, scopeContext);
    const execution = createTool.resolveExecution({
      cron: '*/5 * * * *',
      prompt: 'cron-fired prompt',
      recurring: true,
    });
    if (execution.isError === true) {
      throw new Error(
        `CronCreate unexpectedly errored: ${outputText(execution.output)}`,
      );
    }
    const createResult = await execution.execute({
      turnId: 19,
      toolCallId: 'p19-call',
      signal: new AbortController().signal,
    });
    expect(createResult.isError ?? false).toBe(false);
    expect(cron.list().length).toBe(1);

    harness.advance(15 * 60_000);
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
    const createTool = new CronCreateTool(cron, scopeContext);
    const listTool = new CronListTool(cron);
    const deleteTool = new CronDeleteTool(cron, scopeContext);
    const ctxArgs = {
      turnId: 19,
      toolCallId: 'p19-tools-call',
      signal: new AbortController().signal,
    };

    const createExec = createTool.resolveExecution({
      cron: '*/10 * * * *',
      prompt: 'noop',
      recurring: true,
    });
    if (createExec.isError === true) {
      throw new Error(`CronCreate failed: ${outputText(createExec.output)}`);
    }
    const createOut = await createExec.execute(ctxArgs);
    expect(createOut.isError ?? false).toBe(false);
    const idMatch = /id:\s*(\S+)/.exec(outputText(createOut.output));
    expect(idMatch).not.toBeNull();
    const id = idMatch![1]!;

    const listExec = listTool.resolveExecution({});
    if (listExec.isError === true) {
      throw new Error(`CronList failed: ${outputText(listExec.output)}`);
    }
    const listOut = await listExec.execute(ctxArgs);
    expect(listOut.isError ?? false).toBe(false);
    const listText = outputText(listOut.output);
    expect(listText).toContain('cron_jobs: 1');
    expect(listText).toContain(`id: ${id}`);
    expect(listText).toContain('cron: */10 * * * *');

    const deleteExec = deleteTool.resolveExecution({ id });
    if (deleteExec.isError === true) {
      throw new Error(`CronDelete failed: ${outputText(deleteExec.output)}`);
    }
    const deleteOut = await deleteExec.execute(ctxArgs);
    expect(deleteOut.isError ?? false).toBe(false);
    expect(outputText(deleteOut.output)).toContain(`Deleted cron job ${id}`);

    const listExec2 = listTool.resolveExecution({});
    if (listExec2.isError === true) {
      throw new Error(`CronList failed: ${outputText(listExec2.output)}`);
    }
    const listOut2 = await listExec2.execute(ctxArgs);
    expect(listOut2.isError ?? false).toBe(false);
    expect(outputText(listOut2.output)).toContain('cron_jobs: 0');
    expect(outputText(listOut2.output)).toContain('No cron jobs scheduled.');
  });
});
