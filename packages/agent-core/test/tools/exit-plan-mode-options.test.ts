import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../src/agent';
import {
  ExitPlanModeInputSchema,
  ExitPlanModeTool,
  type ExitPlanModeInput,
} from '../../src/tools/builtin/planning/exit-plan-mode';
import DESCRIPTION from '../../src/tools/builtin/planning/exit-plan-mode.md?raw';
import { executeTool } from './fixtures/execute-tool';
import { toolContentString } from './fixtures/fake-kaos';

const signal = new AbortController().signal;

const options = [
  { label: 'Approach A', description: 'Use the smaller refactor.' },
  { label: 'Approach B', description: 'Use the more complete refactor.' },
] satisfies NonNullable<ExitPlanModeInput['options']>;

function makeAgent(
  input: {
    readonly active?: boolean | undefined;
    readonly plan?: string | null | undefined;
    readonly path?: string | undefined;
    readonly planFilePath?: string | null | undefined;
    readonly emit?: ((event: unknown) => void) | undefined;
  } = {},
): { agent: Agent; requestApproval: ReturnType<typeof vi.fn>; emit: ReturnType<typeof vi.fn> } {
  let active = input.active ?? true;
  const requestApproval = vi.fn(async () => ({ decision: 'approved' }));
  const emit = vi.fn((event: unknown) => {
    input.emit?.(event);
    if ((event as { type?: string }).type === 'plan_mode.exit') active = false;
  });
  const agent = {
    planMode: {
      get isActive() {
        return active;
      },
      get planFilePath() {
        return input.planFilePath ?? null;
      },
      data: vi.fn(async () => {
        if (input.plan === null) return null;
        return {
          content: input.plan ?? 'plan from file',
          path: input.path ?? '/tmp/plan.md',
        };
      }),
      exit: () => {
        emit({ type: 'plan_mode.exit' });
      },
    },
    rpc: { requestApproval },
    telemetry: { track: vi.fn() },
    emit,
  } as unknown as Agent;
  return { agent, requestApproval, emit };
}

function execute(
  tool: ExitPlanModeTool,
  args: ExitPlanModeInput,
  metadata?: unknown,
) {
  return executeTool(tool, {
    turnId: '7',
    toolCallId: 'call_exit_plan',
    args,
    metadata,
    signal,
  });
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

describe('ExitPlanMode option output', () => {
  it('treats a single option as plain plan approval', async () => {
    const { agent, requestApproval, emit } = makeAgent({
      plan: 'single option plan',
    });

    const result = await execute(new ExitPlanModeTool(agent), {
      options: [{ label: 'Approach A', description: 'Only path' }],
    });

    expect(requestApproval).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith({ type: 'plan_mode.exit' });
    expect(result.output).toContain('Exited plan mode');
  });

  it('does not use inline plan fallback for option approval when no plan file exists', async () => {
    const { agent, requestApproval, emit } = makeAgent({
      plan: null,
    });

    const result = await execute(new ExitPlanModeTool(agent), {
      options,
    });

    expect(requestApproval).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('No plan file found');
  });

  it('returns success without a "User feedback:" prefix when revise has no feedback', async () => {
    const { agent } = makeAgent({ plan: 'draft plan' });

    const result = await execute(new ExitPlanModeTool(agent), { options });

    expect(result.isError).toBeFalsy();
    expect(toolContentString(result)).not.toContain('User feedback:');
  });
});

describe('ExitPlanMode reserved-label validation', () => {
  it('rejects reserved label "Reject"', () => {
    const parsed = ExitPlanModeInputSchema.safeParse({
      options: [{ label: 'Reject', description: 'x' }],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects reserved label "reject" case-insensitively', () => {
    const parsed = ExitPlanModeInputSchema.safeParse({
      options: [{ label: 'reject', description: 'x' }],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects reserved label "Revise"', () => {
    const parsed = ExitPlanModeInputSchema.safeParse({
      options: [{ label: 'Revise', description: 'x' }],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects reserved label "Approve"', () => {
    const parsed = ExitPlanModeInputSchema.safeParse({
      options: [{ label: 'Approve', description: 'x' }],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects reserved label after whitespace trim ("  Reject  ")', () => {
    const parsed = ExitPlanModeInputSchema.safeParse({
      options: [{ label: '  Reject  ', description: 'x' }],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects duplicate option labels (case-insensitive uniqueness)', () => {
    const parsed = ExitPlanModeInputSchema.safeParse({
      options: [
        { label: 'Patch config', description: '' },
        { label: 'patch config', description: 'different desc' },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});

describe('ExitPlanMode options documentation consistency', () => {
  function optionsParamDescription(): string {
    const tool = new ExitPlanModeTool({} as Agent);
    const parameters = tool.parameters as {
      properties?: { options?: { description?: string } };
    };
    const description = parameters.properties?.options?.description;
    expect(typeof description).toBe('string');
    return description as string;
  }

  it('does not advertise a 2-3 option minimum that contradicts the minItems:1 schema', () => {
    expect(DESCRIPTION).not.toMatch(/2-3 options/);
    expect(optionsParamDescription()).not.toMatch(/2-3 options/);
  });

  it('keeps single-option / plain-approval semantics in the options param only, not duplicated in the .md', () => {
    // Field mechanics are the options param describe's job (single source of
    // truth). The tool description routes to the param instead of repeating
    // them, so the two surfaces cannot drift.
    expect(optionsParamDescription()).toMatch(/single option/i);
    expect(optionsParamDescription()).toMatch(/plain plan approval/i);
    expect(DESCRIPTION).not.toMatch(/single option/i);
    expect(DESCRIPTION).toMatch(/pass them via the .?options.? parameter/i);
  });
});
