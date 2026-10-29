import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPlanService } from '#/features/plan/plan';

import { runWillBeginStepHooks, type StubLoop } from '../../../agent/loop/stubs';
import { createTestAgent, execEnvServices, type TestAgentContext } from '../../../harness';
import { createFakeHostFs } from '../../../tools/fixtures/fake-exec';

async function enterPlan(plan: IAgentPlanService, id = 'test-plan'): Promise<string> {
  await plan.enter(id, false);
  const status = await plan.status();
  if (status === null) {
    throw new Error('expected plan file path');
  }
  return status.path;
}

async function injectDynamic(ctx: TestAgentContext): Promise<void> {
  await runWillBeginStepHooks(ctx.get(IAgentLoopService) as StubLoop, false);
}

function appendAssistantTurn(
  ctx: TestAgentContext,
  context: IAgentContextMemoryService,
  text: string,
): void {
  ctx.appendAssistantTurn(context.get().length, text);
}

function planReminderMessages(context: IAgentContextMemoryService): readonly ContextMessage[] {
  return context.get().filter((message) => {
    return message.origin?.kind === 'injection' && message.origin.variant === 'plan_mode';
  });
}

function lastPlanReminder(context: IAgentContextMemoryService): string {
  const message = planReminderMessages(context).at(-1);
  if (message === undefined) return '';
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

describe('PlanModeService dynamic injection content', () => {
  let ctx: TestAgentContext;
  let context: IAgentContextMemoryService;
  let plan: IAgentPlanService;
  let readText: (path: string) => Promise<string>;

  beforeEach(async () => {
    readText = async () => '';
    ctx = createTestAgent(
      execEnvServices({
        hostFs: createFakeHostFs({
          mkdir: vi.fn().mockResolvedValue(undefined),
          readText: (path: string) => readText(path),
          writeText: vi.fn(async () => undefined),
        }),
      }),
    );
    context = ctx.get(IAgentContextMemoryService);
    plan = ctx.get(IAgentPlanService);
    await ctx.restorePersisted();
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('injects the full reminder with the current plan file footer', async () => {
    const planFilePath = await enterPlan(plan);

    await injectDynamic(ctx);
    const text = lastPlanReminder(context);

    expect(text).toContain('Write');
    expect(text).toContain('Edit');
    expect(text).toContain('ExitPlanMode');
    expect(text).toContain(`Plan file: ${planFilePath}`);
  });

  it('lets the model answer in text while plan mode stays on', async () => {
    await enterPlan(plan);

    await injectDynamic(ctx);
    const text = lastPlanReminder(context);

    expect(text).toContain('answer in text');
    expect(text).not.toContain('any other way');
  });

  it('derives a plan file path before injecting the full reminder', async () => {
    const planFilePath = await enterPlan(plan, 'derived-plan');

    await injectDynamic(ctx);

    expect(planFilePath).toContain('derived-plan.md');
    expect(lastPlanReminder(context)).toContain(`Plan file: ${planFilePath}`);
  });

  it('injects the exit reminder when plan mode turns off after being active', async () => {
    await enterPlan(plan);

    await injectDynamic(ctx);
    plan.exit();
    await injectDynamic(ctx);

    expect(planReminderMessages(context)).toHaveLength(2);
    const text = lastPlanReminder(context);
    expect(text).toContain('If the user approved a plan, carry it out');
    expect(text).toContain("otherwise follow the user's latest message");
    expect(text).not.toContain('Continue with the approved plan');
  });

  it('does not inject anything when plan mode is inactive from the start', async () => {
    await injectDynamic(ctx);

    expect(planReminderMessages(context)).toHaveLength(0);
    expect(context.get()).toHaveLength(0);
  });

  it('injects a reentry reminder when restored plan mode already has plan content', async () => {
    readText = vi.fn(async () => '# Existing Plan\n\n- Keep this context');
    await ctx.dispatch({
      type: 'plan_mode.enter',
      id: 'restored-plan',
    });

    await injectDynamic(ctx);

    expect(lastPlanReminder(context)).toContain('Re-entering Plan Mode');
  });
});

describe('PlanModeService dynamic injection cadence', () => {
  let ctx: TestAgentContext;
  let context: IAgentContextMemoryService;
  let plan: IAgentPlanService;

  beforeEach(async () => {
    ctx = createTestAgent(
      execEnvServices({
        hostFs: createFakeHostFs({
          mkdir: vi.fn().mockResolvedValue(undefined),
          readText: async () => '',
          writeText: vi.fn(async () => undefined),
        }),
      }),
    );
    context = ctx.get(IAgentContextMemoryService);
    plan = ctx.get(IAgentPlanService);
    await ctx.restorePersisted();
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('skips reinjection before the assistant-turn threshold', async () => {
    await enterPlan(plan);

    await injectDynamic(ctx);
    appendAssistantTurn(ctx, context, 'assistant one');
    await injectDynamic(ctx);

    expect(planReminderMessages(context)).toHaveLength(1);
  });

  it('injects the sparse reminder after the short assistant-turn threshold', async () => {
    const planFilePath = await enterPlan(plan);

    await injectDynamic(ctx);
    appendAssistantTurn(ctx, context, 'assistant one');
    appendAssistantTurn(ctx, context, 'assistant two');
    await injectDynamic(ctx);

    const text = lastPlanReminder(context);
    expect(text).toContain('Plan mode still active');
    expect(text).toContain('see full instructions earlier');
    expect(text).toContain('Stay read-only except the plan file');
    expect(text).toContain('AskUserQuestion');
    expect(text).toContain('ExitPlanMode');
    expect(text).not.toContain('Bash follows the normal permission mode');
    expect(text).toContain(`Plan file: ${planFilePath}`);
  });

  it('does not refresh the full reminder for another system injection', async () => {
    await enterPlan(plan);

    await injectDynamic(ctx);
    ctx.appendSystemReminder('AGENTS.md changed', { kind: 'injection', variant: 'agents_md' });
    await injectDynamic(ctx);

    expect(planReminderMessages(context)).toHaveLength(1);
  });

  it('refreshes the full reminder after the long assistant-turn threshold', async () => {
    await enterPlan(plan);

    await injectDynamic(ctx);
    for (let i = 0; i < 5; i += 1) {
      appendAssistantTurn(ctx, context, `assistant ${String(i)}`);
    }
    await injectDynamic(ctx);

    const text = lastPlanReminder(context);
    expect(text).toContain('Plan mode is active');
    expect(text).not.toContain('Plan mode still active');
  });

  it('refreshes the full reminder if a user message appears after the last injection', async () => {
    await enterPlan(plan);

    await injectDynamic(ctx);
    ctx.appendUserMessage([{ type: 'text', text: 'next task' }]);
    await injectDynamic(ctx);

    const text = lastPlanReminder(context);
    expect(text).toContain('Plan mode is active');
    expect(text).not.toContain('Plan mode still active');
  });

  it('refreshes the full reminder if a user message follows another injection', async () => {
    await enterPlan(plan);

    await injectDynamic(ctx);
    ctx.appendSystemReminder('AGENTS.md changed', { kind: 'injection', variant: 'agents_md' });
    ctx.appendUserMessage([{ type: 'text', text: 'next task' }]);
    await injectDynamic(ctx);

    const text = lastPlanReminder(context);
    expect(text).toContain('Plan mode is active');
    expect(text).not.toContain('Plan mode still active');
  });
});
