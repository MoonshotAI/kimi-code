import { describe, expect, it, vi } from 'vitest';

import type { IAgentPlanService, PlanData } from '#/features/plan/plan';
import {
  ExitPlanModeInputSchema,
  type ExitPlanModeInput,
} from '#/features/plan/tools/exit-plan-mode/exit-plan-mode';
import { ExitPlanModeTool } from '#/features/plan/tools/exit-plan-mode/exitPlanModeTool';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';

import { executeTool } from '../../../tools/fixtures/execute-tool';

const signal = new AbortController().signal;


const options = [
  { label: 'Approach A', description: 'Small change.' },
  { label: 'Approach B', description: 'Larger change.' },
] satisfies NonNullable<ExitPlanModeInput['options']>;

function planService(): IAgentPlanService {
  return {
    _serviceBrand: undefined,
    enter: async () => {},
    cancel: () => {},
    clear: async () => {},
    exit: vi.fn(),
    resolveFile: async () => undefined,
    recordRevision: async () => {},
    status: async () =>
      ({
        id: 'test-plan',
        content: '# Plan',
        path: '/tmp/kimi-plan.md',
      } satisfies NonNullable<PlanData>),
  };
}

async function reviewDisplay(
  service: IAgentPlanService,
  args: ExitPlanModeInput,
): Promise<ToolInputDisplay | undefined> {
  const execution = await new ExitPlanModeTool(service).resolveExecution(args);
  if ('isError' in execution && execution.isError === true) {
    throw new Error('expected a runnable ExitPlanMode execution');
  }
  return execution.display;
}

describe('ExitPlanMode options schema', () => {
  it('accepts 1-3 options and rejects inline plan fallback', () => {
    expect(
      ExitPlanModeInputSchema.safeParse({
        options: [{ label: 'A', description: 'do A' }],
      }).success,
    ).toBe(true);
    expect(
      ExitPlanModeInputSchema.safeParse({
        options: [
          { label: 'A', description: 'do A' },
          { label: 'B', description: 'do B' },
          { label: 'C', description: 'do C' },
        ],
      }).success,
    ).toBe(true);
    expect(ExitPlanModeInputSchema.safeParse({}).success).toBe(true);
    expect(ExitPlanModeInputSchema.safeParse({ plan: 'Plan' }).success).toBe(false);
  });

  it('rejects too many options, duplicate labels, reserved labels, and invalid labels', () => {
    expect(
      ExitPlanModeInputSchema.safeParse({
        options: [
          { label: 'A', description: 'x' },
          { label: 'B', description: 'x' },
          { label: 'C', description: 'x' },
          { label: 'D', description: 'x' },
        ],
      }).success,
    ).toBe(false);
    expect(
      ExitPlanModeInputSchema.safeParse({
        options: [{ label: '', description: 'x' }],
      }).success,
    ).toBe(false);
    expect(
      ExitPlanModeInputSchema.safeParse({
        options: [{ label: 'a'.repeat(81), description: 'x' }],
      }).success,
    ).toBe(false);
    expect(
      ExitPlanModeInputSchema.safeParse({
        options: [
          { label: 'A', description: 'x' },
          { label: 'A', description: 'y' },
        ],
      }).success,
    ).toBe(false);
    expect(
      ExitPlanModeInputSchema.safeParse({
        options: [{ label: 'Reject', description: 'reserved' }],
      }).success,
    ).toBe(false);
    expect(
      ExitPlanModeInputSchema.safeParse({
        options: [{ label: 'reject', description: 'reserved' }],
      }).success,
    ).toBe(false);
    expect(
      ExitPlanModeInputSchema.safeParse({
        options: [{ label: '  Reject  ', description: 'reserved' }],
      }).success,
    ).toBe(false);
    expect(
      ExitPlanModeInputSchema.safeParse({
        options: [
          { label: 'Patch config', description: 'x' },
          { label: '  patch CONFIG  ', description: 'y' },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('ExitPlanMode review display', () => {
  it('treats a single option as plain plan approval', async () => {
    const display = await reviewDisplay(planService(), {
      options: [{ label: 'Approach A', description: 'Only path' }],
    });

    expect(display).toEqual({
      kind: 'plan_review',
      plan: '# Plan',
      path: '/tmp/kimi-plan.md',
    });
  });

  it('offers two or more options to the reviewer', async () => {
    const display = await reviewDisplay(planService(), { options });

    expect(display).toEqual({
      kind: 'plan_review',
      plan: '# Plan',
      path: '/tmp/kimi-plan.md',
      options,
    });
  });

  it('records a revision once per submission when the review display resolves', async () => {
    const recordRevision = vi.fn(async () => {});
    const service: IAgentPlanService = { ...planService(), recordRevision };

    const display = await reviewDisplay(service, {});

    expect(display?.kind).toBe('plan_review');
    expect(recordRevision).toHaveBeenCalledTimes(1);
  });

  it('still builds the review display when revision recording fails', async () => {
    const recordRevision = vi.fn(async () => {
      throw new Error('disk full');
    });
    const service: IAgentPlanService = { ...planService(), recordRevision };

    const display = await reviewDisplay(service, {});

    expect(recordRevision).toHaveBeenCalledTimes(1);
    expect(display?.kind).toBe('plan_review');
  });

  it('skips revision recording when the plan content is empty', async () => {
    const recordRevision = vi.fn(async () => {});
    const service: IAgentPlanService = {
      ...planService(),
      recordRevision,
      status: async () => ({ id: 'test-plan', content: '   ', path: '/tmp/kimi-plan.md' }),
    };

    const result = await executeTool(new ExitPlanModeTool(service), {
      turnId: 7,
      toolCallId: 'call_exit_empty',
      args: {},
      signal,
    });

    expect(recordRevision).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.output).toContain('No plan file found');
  });
});

describe('ExitPlanMode without a review', () => {
  it('keeps plan mode active instead of exiting when the plan was not reviewed', async () => {
    const exit = vi.fn();

    const result = await executeTool(new ExitPlanModeTool({ ...planService(), exit }), {
      turnId: 7,
      toolCallId: 'call_exit_unreviewed',
      args: { options },
      signal,
    });

    expect(exit).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.output).toContain('could not be shown to the user for review');
    expect(result.output).not.toContain('## Approved Plan:');
  });

  it('tells the model that only the user can turn plan mode on when plan mode is off', async () => {
    const result = await executeTool(
      new ExitPlanModeTool({ ...planService(), status: async () => null }),
      {
        turnId: 7,
        toolCallId: 'call_exit_inactive',
        args: {},
        signal,
      },
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('only be called while plan mode is active');
    expect(result.output).toContain('Only the user can turn plan mode on');
    expect(result.output).not.toContain('EnterPlanMode');
  });
});
