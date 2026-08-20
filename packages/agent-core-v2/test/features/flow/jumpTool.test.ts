import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { TestInstantiationService } from '#/_base/di/test';
import {
  IAgentFlowService,
  type FlowJumpPolicy,
  type FlowStageDefinition,
} from '#/features/flow/flow';
import { FlowJumpTool } from '#/features/flow/tools/jump/jumpTool';
import type { FlowJumpInput } from '#/features/flow/tools/jump/jump';
import type { RunnableToolExecution, ToolExecution } from '#/tool/toolContract';

function runnable(execution: ToolExecution): RunnableToolExecution {
  if (!('execute' in execution)) throw new Error('expected a runnable execution');
  return execution;
}

const CTX = {
  turnId: 0,
  toolCallId: 'call_jump',
  signal: new AbortController().signal,
};

const STAGES: FlowStageDefinition[] = [
  { id: 'triage', objective: 'find it', completion: 'found', gate: 'human' },
  { id: 'implement', objective: 'fix it', completion: 'fixed', gate: 'ai' },
  { id: 'verify', objective: 'verify it', completion: 'verified', gate: 'human' },
];

const ARGS: FlowJumpInput = { to: 'verify', reason: 'implement already covered by earlier work' };

describe('FlowJumpTool', () => {
  let ix: TestInstantiationService;
  let tool: FlowJumpTool;
  let stageIndex: number;
  let active: boolean;
  let mode: string;
  let policy: FlowJumpPolicy;
  let epoch: number;
  let jump: ReturnType<typeof vi.fn>;
  let approvedCalls: Set<string>;

  beforeEach(() => {
    ix = new TestInstantiationService();
    stageIndex = 0;
    active = true;
    mode = 'default';
    policy = 'approval';
    epoch = 1;
    jump = vi.fn((outcome: { to: string }) => {
      const stage = STAGES.find((candidate) => candidate.id === outcome.to);
      return { recorded: stage !== undefined, stage };
    });
    approvedCalls = new Set(['call_jump']);
    ix.stub(IAgentFlowService, {
      run: () => ({
        active,
        flowId: 'issue-fix',
        task: 'fix #1',
        stages: STAGES,
        currentStageIndex: stageIndex,
      }),
      currentStage: () => (active ? STAGES[stageIndex] : undefined),
      jump,
      jumpPolicy: () => policy,
      consumeGateApproval: (toolCallId: string) => approvedCalls.delete(toolCallId),
      runEpoch: () => epoch,
      stampPreparedEpoch: () => {},
      preparedEpochOf: () => undefined,
    } as unknown as IAgentFlowService);
    ix.stub(IAgentPermissionModeService, {
      get mode() {
        return mode;
      },
    } as unknown as IAgentPermissionModeService);
    tool = ix.createInstance(FlowJumpTool);
  });

  it('attaches a flow_jump_review display under every jump policy', () => {
    const execution = runnable(tool.resolveExecution(ARGS));
    expect(execution.display).toMatchObject({
      kind: 'flow_jump_review',
      flow_id: 'issue-fix',
      from_stage_id: 'triage',
      to_stage_id: 'verify',
      from_index: 0,
      to_index: 2,
      stage_total: 3,
      reason: ARGS.reason,
    });
    policy = 'free';
    expect(runnable(tool.resolveExecution(ARGS)).display).toMatchObject({
      kind: 'flow_jump_review',
      reason: ARGS.reason,
    });
    policy = 'disabled';
    expect(runnable(tool.resolveExecution(ARGS)).display).toMatchObject({
      kind: 'flow_jump_review',
      reason: ARGS.reason,
    });
  });

  it('attaches no display for the current stage or an unknown stage', () => {
    expect(
      runnable(tool.resolveExecution({ to: 'triage', reason: 'noop' })).display,
    ).toBeUndefined();
    expect(
      runnable(tool.resolveExecution({ to: 'missing', reason: 'nope' })).display,
    ).toBeUndefined();
  });

  it('records a reviewed jump as decided by human', async () => {
    const result = await runnable(tool.resolveExecution(ARGS)).execute(CTX);
    expect(result.isError).not.toBe(true);
    expect(result.output).toContain('Jumped to stage `verify`');
    expect(result.output).toContain(`Reason: ${ARGS.reason}`);
    expect(jump).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'verify', decidedBy: 'human' }),
    );
  });

  it('records a free-policy jump as decided by ai without review', async () => {
    policy = 'free';
    approvedCalls.clear();
    const result = await runnable(tool.resolveExecution(ARGS)).execute(CTX);
    expect(result.isError).not.toBe(true);
    expect(jump).toHaveBeenCalledWith(expect.objectContaining({ decidedBy: 'ai' }));
  });

  it('records an auto-mode jump as decided by auto, with a note', async () => {
    mode = 'auto';
    approvedCalls.clear();
    const result = await runnable(tool.resolveExecution(ARGS)).execute(CTX);
    expect(result.isError).not.toBe(true);
    expect(result.output).toContain('auto-approved');
    expect(jump).toHaveBeenCalledWith(expect.objectContaining({ decidedBy: 'auto' }));
  });

  it('rejects an unreviewed jump under the approval policy', async () => {
    approvedCalls.clear();
    const result = await runnable(tool.resolveExecution(ARGS)).execute(CTX);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('standalone call');
    expect(jump).not.toHaveBeenCalled();
  });

  it('rejects a jump when the flow forbids jumps', async () => {
    policy = 'disabled';
    const result = await runnable(tool.resolveExecution(ARGS)).execute(CTX);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('forbids stage jumps');
    expect(jump).not.toHaveBeenCalled();
  });

  it('rejects a jump to the current stage and to an unknown stage', async () => {
    const same = await runnable(
      tool.resolveExecution({ to: 'triage', reason: 'noop' }),
    ).execute(CTX);
    expect(same.isError).toBe(true);
    expect(same.output).toContain('already at stage');
    const missing = await runnable(
      tool.resolveExecution({ to: 'missing', reason: 'nope' }),
    ).execute(CTX);
    expect(missing.isError).toBe(true);
    expect(missing.output).toContain('Unknown stage');
    expect(jump).not.toHaveBeenCalled();
  });

  it('rejects a jump prepared against a run that changed before execution', async () => {
    const execution = runnable(tool.resolveExecution(ARGS));
    epoch = 2;
    const result = await execution.execute(CTX);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('changed after this call was prepared');
    expect(jump).not.toHaveBeenCalled();
  });

  it('rejects whitespace-only reasons at execution', async () => {
    const result = await runnable(
      tool.resolveExecution({ to: 'verify', reason: '   ' } as FlowJumpInput),
    ).execute(CTX);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('Invalid FlowJump input');
    expect(jump).not.toHaveBeenCalled();
  });
});
