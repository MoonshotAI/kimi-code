import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../../src/agent';
import {
  PermissionManager,
  type ApprovalResponse,
  type PermissionMode,
} from '../../../src/agent/permission';
import type { ToolExecutionHookContext } from '../../../src/loop';
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
    permission: { mode: input.mode },
    type: 'main',
    config: { cwd: '/workspace' },
    runtime: { kaos: createFakeKaos() },
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
  const manager = new PermissionManager(agent);
  manager.mode = agent.permission.mode;
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

function permissionContext(args: ExitPlanModeInput): ToolExecutionHookContext {
  return {
    turnId: '7',
    stepNumber: 1,
    signal: new AbortController().signal,
    llm: {} as ToolExecutionHookContext['llm'],
    toolCall: {
      id: 'call_exit_plan',
      type: 'function',
      name: 'ExitPlanMode',
        arguments: JSON.stringify(args),
    },
    args,
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

  it('tracks revision requests with feedback', async () => {
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
  });

  it('tracks plain rejections without exiting plan mode', async () => {
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
  });

  it('tracks dismissed approval dialogs without exiting plan mode', async () => {
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
  });

  it('tracks reject-and-exit and exits plan mode', async () => {
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
  });
});
