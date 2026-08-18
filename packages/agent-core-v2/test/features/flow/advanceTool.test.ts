import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { TestInstantiationService } from '#/_base/di/test';
import {
  IAgentFlowService,
  type FlowAdvanceOutcome,
  type FlowStageDefinition,
} from '#/features/flow/flow';
import { FlowAdvanceTool } from '#/features/flow/tools/advance/advanceTool';
import { FlowAdvanceInputSchema, type FlowAdvanceInput } from '#/features/flow/tools/advance/advance';
import type { RunnableToolExecution, ToolExecution } from '#/tool/toolContract';

function runnable(execution: ToolExecution): RunnableToolExecution {
  if (!('execute' in execution)) throw new Error('expected a runnable execution');
  return execution;
}

const CTX = {
  turnId: 0,
  toolCallId: 'call_advance',
  signal: new AbortController().signal,
};

const STAGES: FlowStageDefinition[] = [
  { id: 'triage', objective: 'find it', completion: 'found', gate: 'human' },
  { id: 'implement', objective: 'fix it', completion: 'fixed', gate: 'ai' },
];

const MET = [{ criterion: 'found', met: true, evidence: 'src/x.ts:12' }];

describe('FlowAdvanceTool', () => {
  let ix: TestInstantiationService;
  let tool: FlowAdvanceTool;
  let stageIndex: number;
  let active: boolean;
  let mode: string;
  let advance: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ix = new TestInstantiationService();
    stageIndex = 0;
    active = true;
    mode = 'default';
    advance = vi.fn(
      (outcome: FlowAdvanceOutcome) =>
        ({ recorded: true, runFinished: false, nextStage: STAGES[stageIndex + 1] }) as const,
    );
    ix.stub(IAgentFlowService, {
      run: () => ({ active, flowId: 'issue-fix', task: 'fix #1', stages: STAGES, currentStageIndex: stageIndex }),
      currentStage: () => (active ? STAGES[stageIndex] : undefined),
      advance,
    } as unknown as IAgentFlowService);
    ix.stub(IAgentPermissionModeService, {
      get mode() {
        return mode;
      },
    } as unknown as IAgentPermissionModeService);
    tool = ix.createInstance(FlowAdvanceTool);
  });

  function passArgs(stage: string): FlowAdvanceInput {
    return { stage, verdict: 'pass', criteria: MET };
  }

  it('attaches a flow_gate_review display only for a human-gated pass on the current stage', () => {
    expect(runnable(tool.resolveExecution(passArgs('triage'))).display?.kind).toBe('flow_gate_review');
    expect(runnable(tool.resolveExecution(passArgs('implement'))).display).toBeUndefined();
    stageIndex = 1;
    expect(runnable(tool.resolveExecution(passArgs('implement'))).display).toBeUndefined();
  });

  it('rejects a human-gated pass whose review was skipped because the stage changed after preparation', async () => {
    stageIndex = 1;
    const execution = runnable(tool.resolveExecution(passArgs('triage')));
    expect(execution.display).toBeUndefined();
    stageIndex = 0;
    const result = await execution.execute(CTX);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('standalone call');
    expect(advance).not.toHaveBeenCalled();
  });

  it('records a reviewed human-gated pass as decided by human', async () => {
    const execution = runnable(tool.resolveExecution(passArgs('triage')));
    expect(execution.display?.kind).toBe('flow_gate_review');
    const result = await execution.execute(CTX);
    expect(result.isError).not.toBe(true);
    expect(advance).toHaveBeenCalledWith(expect.objectContaining({ result: 'pass', decidedBy: 'human' }));
  });

  it('records an auto-mode human-gated pass as decided by auto, with a note', async () => {
    mode = 'auto';
    const execution = runnable(tool.resolveExecution(passArgs('triage')));
    const result = await execution.execute(CTX);
    expect(result.isError).not.toBe(true);
    expect(result.output).toContain('auto-approved');
    expect(advance).toHaveBeenCalledWith(expect.objectContaining({ decidedBy: 'auto' }));
  });

  it('rejects a pass verdict that carries unmet criteria', async () => {
    const args: FlowAdvanceInput = {
      stage: 'triage',
      verdict: 'pass',
      criteria: [{ criterion: 'found', met: false, evidence: 'not yet' }],
    };
    const result = await runnable(tool.resolveExecution(args)).execute(CTX);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('every criterion to be met');
    expect(advance).not.toHaveBeenCalled();
  });

  it('rejects a reject verdict whose criteria are all met', async () => {
    const args: FlowAdvanceInput = {
      stage: 'triage',
      verdict: 'reject',
      criteria: [{ criterion: 'found', met: true, evidence: 'src/x.ts:12' }],
    };
    const result = await runnable(tool.resolveExecution(args)).execute(CTX);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('at least one unmet criterion');
    expect(advance).not.toHaveBeenCalled();
  });

  it('the input schema rejects blank criterion text and blank evidence', () => {
    const blankEvidence = FlowAdvanceInputSchema.safeParse({
      stage: 'triage',
      verdict: 'pass',
      criteria: [{ criterion: 'found', met: true, evidence: '   ' }],
    });
    expect(blankEvidence.success).toBe(false);
    const blankCriterion = FlowAdvanceInputSchema.safeParse({
      stage: 'triage',
      verdict: 'pass',
      criteria: [{ criterion: '', met: true, evidence: 'src/x.ts:12' }],
    });
    expect(blankCriterion.success).toBe(false);
  });

  it('records an ai-gated pass without review', async () => {
    stageIndex = 1;
    const execution = runnable(tool.resolveExecution(passArgs('implement')));
    expect(execution.display).toBeUndefined();
    const result = await execution.execute(CTX);
    expect(result.isError).not.toBe(true);
    expect(advance).toHaveBeenCalledWith(expect.objectContaining({ decidedBy: 'ai' }));
  });
});
