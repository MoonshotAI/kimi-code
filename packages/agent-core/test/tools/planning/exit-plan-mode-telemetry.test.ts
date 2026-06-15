import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../../src/agent';
import {
  PermissionManager,
  type ApprovalResponse,
  type PermissionMode,
  type PermissionPolicyContext,
} from '../../../src/agent/permission';
import {
  ExitPlanModeTool,
  type ExitPlanModeInput,
} from '../../../src/tools/builtin/planning/exit-plan-mode';
import { createFakeKaos } from '../fixtures/fake-kaos';
import { executeTool } from '../fixtures/execute-tool';

const options = [
  { label: 'Approach A', description: 'Small change.' },
  { label: 'Approach B', description: 'Larger change.' },
] satisfies NonNullable<ExitPlanModeInput['options']>;

function makeAgent(input: {
  readonly mode: PermissionMode;
  readonly approval?: ApprovalResponse;
}): {
  readonly agent: Agent;
  readonly telemetryTrack: ReturnType<typeof vi.fn>;
  readonly exitPlanMode: ReturnType<typeof vi.fn>;
} {
  let active = true;
  const telemetryTrack = vi.fn();
  const exitPlanMode = vi.fn(() => {
    active = false;
  });
  const agent = {
    planMode: {
      get isActive() {
        return active;
      },
      get planFilePath() {
        return '/tmp/kimi-plan.md';
      },
      data: vi.fn(async () => ({
        content: '# Plan',
        path: '/tmp/kimi-plan.md',
      })),
      exit: exitPlanMode,
    },
    swarmMode: {
      get isActive() {
        return false;
      },
    },
    permission: { mode: input.mode },
    type: 'main',
    config: { cwd: '/workspace' },
    kaos: createFakeKaos(),
    emitStatusUpdated: vi.fn(),
    records: { logRecord: vi.fn() },
    replayBuilder: { push: vi.fn() },
    rpc: {
      requestApproval: vi.fn(async () => input.approval ?? { decision: 'approved' }),
    },
    telemetry: { track: telemetryTrack },
  } as unknown as Agent;
  return { agent, telemetryTrack, exitPlanMode };
}

async function execute(agent: Agent, args: ExitPlanModeInput = {}) {
  const mode = agent.permission.mode;
  const manager = new PermissionManager(agent);
  Object.assign(agent, { permission: manager });
  manager.mode = mode;
  const permissionResult = await manager.beforeToolCall(permissionContext(args));
  if (permissionResult?.syntheticResult !== undefined) {
    return permissionResult.syntheticResult;
  }
  return executeTool(new ExitPlanModeTool(agent), {
    turnId: '7',
    toolCallId: 'call_exit_plan',
    args,
    metadata: permissionResult?.executionMetadata,
    signal: new AbortController().signal,
  });
}

function permissionContext(args: ExitPlanModeInput): PermissionPolicyContext {
  const display: PermissionPolicyContext['execution']['display'] = {
    kind: 'plan_review',
    plan: '# Plan',
    path: '/tmp/kimi-plan.md',
  };
  if (args.options !== undefined && args.options.length >= 2) {
    display.options = args.options;
  }
  return {
    turnId: '7',
    stepNumber: 1,
    signal: new AbortController().signal,
    llm: {} as PermissionPolicyContext['llm'],
    toolCall: {
      id: 'call_exit_plan',
      type: 'function',
      name: 'ExitPlanMode',
      arguments: JSON.stringify(args),
    },
    toolCalls: [
      {
        id: 'call_exit_plan',
        type: 'function',
        name: 'ExitPlanMode',
        arguments: JSON.stringify(args),
      },
    ],
    args,
    execution: {
      description: 'Presenting plan and exiting plan mode',
      display,
      approvalRule: 'ExitPlanMode',
      execute: async () => ({ output: '' }),
    },
  };
}

describe('ExitPlanMode telemetry', () => {
  it('tracks submitted without options and auto approval', async () => {
    const { agent, telemetryTrack, exitPlanMode } = makeAgent({ mode: 'auto' });

    const result = await execute(agent);

    expect(result.isError).toBe(false);
    expect(exitPlanMode).toHaveBeenCalledTimes(1);
    expect(telemetryTrack).toHaveBeenCalledWith('plan_submitted', { has_options: false });
    expect(telemetryTrack).toHaveBeenCalledWith('plan_resolved', {
      outcome: 'auto_approved',
    });
  });

  it('tracks approved multi-option plans with the chosen option', async () => {
    const { agent, telemetryTrack, exitPlanMode } = makeAgent({
      mode: 'manual',
      approval: { decision: 'approved', selectedLabel: 'Approach B' },
    });

    const result = await execute(agent, { options });

    expect(result.isError).toBe(false);
    expect(exitPlanMode).toHaveBeenCalledTimes(1);
    expect(telemetryTrack).toHaveBeenCalledWith('plan_submitted', { has_options: true });
    expect(telemetryTrack).toHaveBeenCalledWith('plan_resolved', {
      outcome: 'approved',
      chosen_option: 'Approach B',
    });
  });

  it('handles revision requests with feedback through permission approval telemetry', async () => {
    const { agent, telemetryTrack, exitPlanMode } = makeAgent({
      mode: 'manual',
      approval: {
        decision: 'rejected',
        selectedLabel: 'Revise',
        feedback: 'Add verification.',
      },
    });

    const result = await execute(agent);

    expect(result.isError).toBe(false);
    expect(exitPlanMode).not.toHaveBeenCalled();
    expect(telemetryTrack).toHaveBeenCalledWith('plan_resolved', {
      outcome: 'revise',
      has_feedback: true,
    });
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_approval_result',
      expect.objectContaining({
        result: 'rejected',
        has_feedback: true,
      }),
    );
  });

  it('handles plain rejections without exiting plan mode', async () => {
    const { agent, telemetryTrack, exitPlanMode } = makeAgent({
      mode: 'manual',
      approval: { decision: 'rejected' },
    });

    const result = await execute(agent);

    expect(result.isError).toBe(true);
    expect(exitPlanMode).not.toHaveBeenCalled();
    expect(telemetryTrack).toHaveBeenCalledWith('plan_resolved', {
      outcome: 'rejected',
    });
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_approval_result',
      expect.objectContaining({
        result: 'rejected',
      }),
    );
  });

  it('handles dismissed approval dialogs without exiting plan mode', async () => {
    const { agent, telemetryTrack, exitPlanMode } = makeAgent({
      mode: 'manual',
      approval: { decision: 'cancelled' },
    });

    const result = await execute(agent);

    expect(result.isError).toBe(false);
    expect(result.output).toContain('dismissed');
    expect(exitPlanMode).not.toHaveBeenCalled();
    expect(telemetryTrack).toHaveBeenCalledWith('plan_resolved', {
      outcome: 'dismissed',
    });
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_approval_result',
      expect.objectContaining({
        result: 'cancelled',
      }),
    );
  });

  it('handles reject-and-exit and exits plan mode', async () => {
    const { agent, telemetryTrack, exitPlanMode } = makeAgent({
      mode: 'manual',
      approval: { decision: 'rejected', selectedLabel: 'Reject and Exit' },
    });

    const result = await execute(agent);

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Plan mode deactivated');
    expect(exitPlanMode).toHaveBeenCalledTimes(1);
    expect(telemetryTrack).toHaveBeenCalledWith('plan_resolved', {
      outcome: 'rejected_and_exited',
    });
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_approval_result',
      expect.objectContaining({
        result: 'rejected',
      }),
    );
  });

  it('does not track auto_approved when exitPlanMode fails', async () => {
    const { agent, telemetryTrack, exitPlanMode } = makeAgent({ mode: 'auto' });
    exitPlanMode.mockImplementation(() => {
      throw new Error('state transition failure');
    });

    const result = await execute(agent);

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Failed to exit plan mode');
    expect(exitPlanMode).toHaveBeenCalledTimes(1);
    expect(telemetryTrack).toHaveBeenCalledWith('plan_submitted', { has_options: false });
    expect(telemetryTrack).not.toHaveBeenCalledWith('plan_resolved', {
      outcome: 'auto_approved',
    });
  });

  it('does not track approved when exitPlanMode fails', async () => {
    const { agent, telemetryTrack, exitPlanMode } = makeAgent({
      mode: 'manual',
      approval: { decision: 'approved' },
    });
    exitPlanMode.mockImplementation(() => {
      throw new Error('state transition failure');
    });

    const result = await execute(agent);

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Failed to exit plan mode');
    expect(exitPlanMode).toHaveBeenCalledTimes(1);
    expect(telemetryTrack).toHaveBeenCalledWith('plan_submitted', { has_options: false });
    expect(telemetryTrack).not.toHaveBeenCalledWith('plan_resolved', {
      outcome: 'approved',
    });
  });
});
