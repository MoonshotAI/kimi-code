import { describe, expect, it, vi } from 'vitest';

import { createFakeKaos } from '../../../tools/fixtures/fake-kaos';
import {
  IDynamicInjector,
  IPlanModeService,
  type ContextMessage,
} from '../../../../src/services/agent';
import { testAgent } from '../harness';

type InjectableDynamicInjector = {
  inject(): Promise<void>;
};

function createPlanAgent({
  readText,
}: {
  readonly readText?: (path: string) => Promise<string>;
} = {}) {
  const readPlanText = readText ?? (async () => '');
  const ctx = testAgent({
    kaos: createFakeKaos({
      mkdir: vi.fn().mockResolvedValue(undefined),
      readText: readPlanText,
      writeText: vi.fn(async (_path: string, content: string) => content.length),
    }),
  });
  ctx.configure();
  return ctx;
}

async function enterPlan(
  ctx: ReturnType<typeof testAgent>,
  id = 'test-plan',
): Promise<string> {
  await ctx.get(IPlanModeService).enter(id, false);
  const planFilePath = ctx.get(IPlanModeService).planFilePath;
  if (planFilePath === null) {
    throw new Error('expected plan file path');
  }
  return planFilePath;
}

async function injectDynamic(ctx: ReturnType<typeof testAgent>): Promise<void> {
  await (ctx.get(IDynamicInjector) as unknown as InjectableDynamicInjector).inject();
}

function appendAssistantTurn(ctx: ReturnType<typeof testAgent>, text: string): void {
  ctx.appendAssistantTurn(ctx.context.getHistory().length, text);
}

function planReminderMessages(ctx: ReturnType<typeof testAgent>): readonly ContextMessage[] {
  return ctx.context.getHistory().filter((message) => {
    return message.origin?.kind === 'injection' && message.origin.variant === 'plan_mode';
  });
}

function lastPlanReminder(ctx: ReturnType<typeof testAgent>): string {
  const message = planReminderMessages(ctx).at(-1);
  if (message === undefined) return '';
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('');
}

describe('PlanModeService dynamic injection content', () => {
  it('injects the full reminder with the current plan file footer', async () => {
    const ctx = createPlanAgent();
    const planFilePath = await enterPlan(ctx);

    await injectDynamic(ctx);
    const text = lastPlanReminder(ctx);

    expect(text).toContain('Plan mode is active');
    expect(text).toContain('current plan file');
    expect(text).toContain('Write');
    expect(text).toContain('Edit');
    expect(text).toContain('ExitPlanMode');
    expect(text).toContain(`Plan file: ${planFilePath}`);
  });

  it('derives a plan file path before injecting the full reminder', async () => {
    const ctx = createPlanAgent();
    const planFilePath = await enterPlan(ctx, 'derived-plan');

    await injectDynamic(ctx);

    expect(planFilePath).toContain('derived-plan.md');
    expect(lastPlanReminder(ctx)).toContain(`Plan file: ${planFilePath}`);
    expect(lastPlanReminder(ctx)).not.toContain('Wait for the host to provide a plan file path');
  });

  it('injects the exit reminder when plan mode turns off after being active', async () => {
    const ctx = createPlanAgent();
    await enterPlan(ctx);

    await injectDynamic(ctx);
    ctx.get(IPlanModeService).exit();
    await injectDynamic(ctx);

    expect(lastPlanReminder(ctx)).toContain('Plan mode is no longer active');
  });

  it('does not inject anything when plan mode is inactive from the start', async () => {
    const ctx = createPlanAgent();

    await injectDynamic(ctx);

    expect(planReminderMessages(ctx)).toHaveLength(0);
    expect(ctx.context.getHistory()).toHaveLength(0);
  });

  it('injects a reentry reminder when restored plan mode already has plan content', async () => {
    const ctx = createPlanAgent({
      readText: vi.fn(async () => '# Existing Plan\n\n- Keep this context'),
    });
    await ctx.dispatch({
      type: 'plan_mode.enter',
      id: 'restored-plan',
    });

    await injectDynamic(ctx);

    expect(lastPlanReminder(ctx)).toContain('Re-entering Plan Mode');
    expect(lastPlanReminder(ctx)).toContain('Read the existing plan file');
  });
});

describe('PlanModeService dynamic injection cadence', () => {
  it('skips reinjection before the assistant-turn threshold', async () => {
    const ctx = createPlanAgent();
    await enterPlan(ctx);

    await injectDynamic(ctx);
    appendAssistantTurn(ctx, 'assistant one');
    await injectDynamic(ctx);

    expect(planReminderMessages(ctx)).toHaveLength(1);
  });

  it('injects the sparse reminder after the short assistant-turn threshold', async () => {
    const ctx = createPlanAgent();
    const planFilePath = await enterPlan(ctx);

    await injectDynamic(ctx);
    appendAssistantTurn(ctx, 'assistant one');
    appendAssistantTurn(ctx, 'assistant two');
    await injectDynamic(ctx);

    const text = lastPlanReminder(ctx);
    expect(text).toContain('Plan mode still active');
    expect(text).toContain('see full instructions earlier');
    expect(text).toContain(`Plan file: ${planFilePath}`);
  });

  it('refreshes the full reminder after the long assistant-turn threshold', async () => {
    const ctx = createPlanAgent();
    await enterPlan(ctx);

    await injectDynamic(ctx);
    for (let i = 0; i < 5; i += 1) {
      appendAssistantTurn(ctx, `assistant ${String(i)}`);
    }
    await injectDynamic(ctx);

    const text = lastPlanReminder(ctx);
    expect(text).toContain('Plan mode is active');
    expect(text).not.toContain('Plan mode still active');
  });

  it('refreshes the full reminder if a user message appears after the last injection', async () => {
    const ctx = createPlanAgent();
    await enterPlan(ctx);

    await injectDynamic(ctx);
    ctx.appendUserMessage([{ type: 'text', text: 'next task' }]);
    await injectDynamic(ctx);

    const text = lastPlanReminder(ctx);
    expect(text).toContain('Plan mode is active');
    expect(text).not.toContain('Plan mode still active');
  });
});
