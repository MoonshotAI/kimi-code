import { describe, expect, it, vi } from 'vitest';

import type { IAgentPlanService, PlanData } from '#/agent/plan/plan';
import {
  ExitPlanModeInputSchema,
  ExitPlanModeTool,
  type ExitPlanModeInput,
} from '#/agent/plan/tools/exit-plan-mode';
import type { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
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
    recordRevision: async () => {},
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

function permissionMode(mode: PermissionMode = 'auto'): IAgentPermissionModeService {
  return {
    _serviceBrand: undefined,
    mode,
    setMode: () => {},
    onDidChangeMode: () => ({ dispose: () => {} }),
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
        permissionMode(),
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

  it('marks the direct-execution output as auto-approved, not user-reviewed, in auto mode', async () => {
    const telemetry = recordingTelemetry();

    const result = await executeTool(
      new ExitPlanModeTool(planService(), permissionMode('auto'), telemetry),
      {
        turnId: 7,
        toolCallId: 'call_exit_plan_auto',
        args: {},
        signal,
      },
    );

    expect(result.isError).toBeFalsy();
    // In auto permission mode no interactive review can happen, so the
    // output must not read as if the user had approved the plan.
    expect(result.output).toContain('## Plan (auto-approved, not user-reviewed):');
    expect(result.output).not.toContain('## Approved Plan:');
    expect(result.output).toContain('the user has NOT explicitly approved it');
    expect(result.output).toContain('# Plan');
  });

  it('keeps the user-approved output when a rule lets the call through outside auto mode', async () => {
    const telemetry = recordingTelemetry();

    const result = await executeTool(
      new ExitPlanModeTool(planService(), permissionMode('manual'), telemetry),
      {
        turnId: 7,
        toolCallId: 'call_exit_plan_rule',
        args: {},
        signal,
      },
    );

    expect(result.isError).toBeFalsy();
    // Outside auto mode the direct-execution path means a configured or
    // session allow/ask rule approved the call — an explicit user decision,
    // so the output keeps the user-approved wording.
    expect(result.output).toContain('## Approved Plan:');
    expect(result.output).not.toContain('auto-approved');
    expect(telemetry.track2).toHaveBeenCalledWith('plan_resolved', {
      outcome: 'approved',
    });
  });

  it('returns success without a "User feedback:" prefix when revise has no feedback', async () => {
    const telemetry = recordingTelemetry();

    const result = await executeTool(
      new ExitPlanModeTool(planService(), permissionMode(), telemetry),
      {
        turnId: 7,
        toolCallId: 'call_exit_plan',
        args: { options },
        signal,
      },
    );

    expect(result.isError).toBeFalsy();
    expect(result.output).not.toContain('User feedback:');
  });

  it('records a revision once per submission when the review display resolves', async () => {
    const recordRevision = vi.fn(async () => {});
    const service: IAgentPlanService = { ...planService(), recordRevision };

    const result = await executeTool(
      new ExitPlanModeTool(service, permissionMode(), recordingTelemetry()),
      {
        turnId: 7,
        toolCallId: 'call_exit_record',
        args: {},
        signal,
      },
    );

    expect(result.isError).toBeFalsy();
    expect(recordRevision).toHaveBeenCalledTimes(1);
  });

  it('still submits when revision recording fails', async () => {
    const recordRevision = vi.fn(async () => {
      throw new Error('disk full');
    });
    const service: IAgentPlanService = { ...planService(), recordRevision };

    const result = await executeTool(
      new ExitPlanModeTool(service, permissionMode(), recordingTelemetry()),
      {
        turnId: 7,
        toolCallId: 'call_exit_record_failure',
        args: {},
        signal,
      },
    );

    expect(recordRevision).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('Exited plan mode');
  });

  it('skips revision recording when the plan content is empty', async () => {
    const recordRevision = vi.fn(async () => {});
    const service: IAgentPlanService = {
      ...planService(),
      recordRevision,
      status: async () => ({ id: 'test-plan', content: '   ', path: '/tmp/kimi-plan.md' }),
    };

    const result = await executeTool(
      new ExitPlanModeTool(service, permissionMode(), recordingTelemetry()),
      {
        turnId: 7,
        toolCallId: 'call_exit_empty',
        args: {},
        signal,
      },
    );

    expect(recordRevision).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.output).toContain('No plan file found');
  });
});
