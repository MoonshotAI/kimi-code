import { describe, expect, it, vi } from 'vitest';

import type { IAgentPlanService, PlanData } from '#/agent/plan/plan';
import {
  ExitPlanModeInputSchema,
  ExitPlanModeTool,
  type ExitPlanModeInput,
} from '#/agent/plan/tools/exit-plan-mode';
import type { ITelemetryService } from '#/app/telemetry/telemetry';

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
    status: async () =>
      ({
        id: 'test-plan',
        content: '# Plan',
        path: '/tmp/kimi-plan.md',
      } satisfies NonNullable<PlanData>),
  };
}

function recordingTelemetry(): ITelemetryService {
  return {
    _serviceBrand: undefined,
    track: vi.fn(),
    track2: vi.fn(),
    withContext: () => recordingTelemetry(),
    setContext: () => {},
    addAppender: () => ({ dispose: () => {} }),
    removeAppender: () => {},
    setAppender: () => {},
    setEnabled: () => {},
    flush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
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
    const exit = vi.fn();
    const telemetry = recordingTelemetry();

    const result = await executeTool(
      new ExitPlanModeTool(
        { ...planService(), exit },
        telemetry,
      ),
      {
        turnId: 7,
        toolCallId: 'call_exit_plan',
        args: { options: [{ label: 'Approach A', description: 'Only path' }] },
        signal,
      },
    );

    expect(exit).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('Exited plan mode');
  });

  it('returns success without a "User feedback:" prefix when revise has no feedback', async () => {
    const telemetry = recordingTelemetry();

    const result = await executeTool(new ExitPlanModeTool(planService(), telemetry), {
      turnId: 7,
      toolCallId: 'call_exit_plan',
      args: { options },
      signal,
    });

    expect(result.isError).toBeFalsy();
    expect(result.output).not.toContain('User feedback:');
  });
});
