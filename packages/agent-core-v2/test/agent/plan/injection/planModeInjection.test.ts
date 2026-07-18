import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeHostFs } from '../../../tools/fixtures/fake-exec';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentPlanService } from '#/agent/plan/plan';
import {
  createTestAgent,
  execEnvServices,
  type TestAgentContext,
} from '../../../harness';

type InjectableDynamicInjector = {
  inject(): Promise<void>;
};

async function enterPlan(
  plan: IAgentPlanService,
  id = 'test-plan',
): Promise<string> {
  await plan.enter(id, false);
  const status = await plan.status();
  if (status === null) {
    throw new Error('expected plan file path');
  }
  return status.path;
}

async function injectDynamic(injector: InjectableDynamicInjector): Promise<void> {
  await injector.inject();
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
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('');
}

describe('PlanModeService dynamic injection content', () => {
  let ctx: TestAgentContext;
  let context: IAgentContextMemoryService;
  let injector: InjectableDynamicInjector;
  let plan: IAgentPlanService;
  let readText: (path: string) => Promise<string>;

  beforeEach(() => {
    readText = async () => '';
    ctx = createTestAgent(execEnvServices({
      hostFs: createFakeHostFs({
        mkdir: vi.fn().mockResolvedValue(undefined),
        readText: (path: string) => readText(path),
        writeText: vi.fn(async () => undefined),
      }),
    }));
    context = ctx.get(IAgentContextMemoryService);
    injector = ctx.get(IAgentContextInjectorService) as unknown as InjectableDynamicInjector;
    plan = ctx.get(IAgentPlanService);
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

    await injectDynamic(injector);
    const text = lastPlanReminder(context);

    expect(text).toContain('Plan mode is active');
    expect(text).toContain('current plan file');
    expect(text).toContain('Write');
    expect(text).toContain('Edit');
    expect(text).toContain('ExitPlanMode');
    expect(text).toContain(`Plan file: ${planFilePath}`);
  });

  it('derives a plan file path before injecting the full reminder', async () => {
    const planFilePath = await enterPlan(plan, 'derived-plan');

    await injectDynamic(injector);

    expect(planFilePath).toContain('derived-plan.md');
    expect(lastPlanReminder(context)).toContain(`Plan file: ${planFilePath}`);
    expect(lastPlanReminder(context)).not.toContain('Wait for the host to provide a plan file path');
  });

  it('injects the exit reminder when plan mode turns off after being active', async () => {
    await enterPlan(plan);

    await injectDynamic(injector);
    plan.exit();
    await injectDynamic(injector);

    expect(lastPlanReminder(context)).toContain('Plan mode is no longer active');
  });

  it('does not inject anything when plan mode is inactive from the start', async () => {
    await injectDynamic(injector);

    expect(planReminderMessages(context)).toHaveLength(0);
    expect(context.get()).toHaveLength(0);
  });

  it('injects a reentry reminder when restored plan mode already has plan content', async () => {
    readText = vi.fn(async () => '# Existing Plan\n\n- Keep this context');
    await ctx.dispatch({
      type: 'plan_mode.enter',
      id: 'restored-plan',
    });

    await injectDynamic(injector);

    expect(lastPlanReminder(context)).toContain('Re-entering Plan Mode');
    expect(lastPlanReminder(context)).toContain('Read the existing plan file');
  });
});

describe('PlanModeService dynamic injection cadence', () => {
  let ctx: TestAgentContext;
  let context: IAgentContextMemoryService;
  let injector: InjectableDynamicInjector;
  let plan: IAgentPlanService;

  beforeEach(() => {
    ctx = createTestAgent(execEnvServices({
      hostFs: createFakeHostFs({
        mkdir: vi.fn().mockResolvedValue(undefined),
        readText: async () => '',
        writeText: vi.fn(async () => undefined),
      }),
    }));
    context = ctx.get(IAgentContextMemoryService);
    injector = ctx.get(IAgentContextInjectorService) as unknown as InjectableDynamicInjector;
    plan = ctx.get(IAgentPlanService);
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

    await injectDynamic(injector);
    appendAssistantTurn(ctx, context, 'assistant one');
    await injectDynamic(injector);

    expect(planReminderMessages(context)).toHaveLength(1);
  });

  it('injects the sparse reminder after the short assistant-turn threshold', async () => {
    const planFilePath = await enterPlan(plan);

    await injectDynamic(injector);
    appendAssistantTurn(ctx, context, 'assistant one');
    appendAssistantTurn(ctx, context, 'assistant two');
    await injectDynamic(injector);

    const text = lastPlanReminder(context);
    expect(text).toContain('Plan mode still active');
    expect(text).toContain('see full instructions earlier');
    expect(text).toContain(`Plan file: ${planFilePath}`);
  });

  it('refreshes the full reminder after the long assistant-turn threshold', async () => {
    await enterPlan(plan);

    await injectDynamic(injector);
    for (let i = 0; i < 5; i += 1) {
      appendAssistantTurn(ctx, context, `assistant ${String(i)}`);
    }
    await injectDynamic(injector);

    const text = lastPlanReminder(context);
    expect(text).toContain('Plan mode is active');
    expect(text).not.toContain('Plan mode still active');
  });

  it('refreshes the full reminder if a user message appears after the last injection', async () => {
    await enterPlan(plan);

    await injectDynamic(injector);
    ctx.appendUserMessage([{ type: 'text', text: 'next task' }]);
    await injectDynamic(injector);

    const text = lastPlanReminder(context);
    expect(text).toContain('Plan mode is active');
    expect(text).not.toContain('Plan mode still active');
  });
});
