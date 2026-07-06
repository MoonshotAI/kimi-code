import type { ToolCall } from '#/app/llmProtocol';
import type { ApprovalResponse, ToolInputDisplay } from '@moonshot-ai/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import type { ResolvedToolExecutionHookContext } from '#/agent/tool';
import { IAgentPermissionModeService } from '#/agent/permissionMode';
import type { PermissionMode } from '#/agent/permissionPolicy';
import { ExitPlanModeReviewAskPermissionPolicyService } from '#/agent/permissionPolicy/policies/exit-plan-mode-review-ask';
import { IAgentPlanService, type IAgentPlanService as AgentPlanService } from '#/agent/plan';
import { ITelemetryService } from '#/app/telemetry';
import { ToolAccesses } from '#/agent/tool';

import { stubPermissionModeService } from '../permissionMode/stubs';
import { recordingTelemetry, type TelemetryRecord } from '../telemetry/stubs';

const options = [
  { label: 'Approach A', description: 'Small change.' },
  { label: 'Approach B', description: 'Larger change.' },
] as const;

type ExitPlanModeFn = AgentPlanService['exit'];

interface RuntimeApprovalResponse {
  readonly decision: ApprovalResponse['decision'];
  readonly selectedLabel?: string;
  readonly feedback?: string;
}

function approvalResponse(response: RuntimeApprovalResponse): ApprovalResponse {
  return response as unknown as ApprovalResponse;
}

function planReviewDisplay(
  input: {
    readonly plan?: string;
    readonly options?: readonly (typeof options)[number][] | undefined;
  } = {},
): ToolInputDisplay {
  const display: ToolInputDisplay = {
    kind: 'plan_review',
    plan: input.plan ?? '# Plan',
    path: '/tmp/kimi-plan.md',
  };
  if (input.options !== undefined) {
    display.options = input.options;
  }
  return display;
}

function policyContext(display: ToolInputDisplay): ResolvedToolExecutionHookContext {
  const toolCall: ToolCall = {
    type: 'function',
    id: 'call_exit_plan',
    name: 'ExitPlanMode',
    arguments: '{}',
  };
  return {
    turnId: 7,
    signal: new AbortController().signal,
    toolCall,
    toolCalls: [toolCall],
    args: {},
    execution: {
      accesses: ToolAccesses.none(),
      approvalRule: 'ExitPlanMode',
      display,
      execute: async () => ({ output: '' }),
    },
  };
}

function planService(exitPlanMode: ExitPlanModeFn = vi.fn()): AgentPlanService {
  return {
    _serviceBrand: undefined,
    enter: async () => {},
    cancel: () => {},
    clear: async () => {},
    exit: exitPlanMode,
    status: async () => ({
      id: 'plan-1',
      content: '# Plan',
      path: '/tmp/kimi-plan.md',
    }),
  };
}

describe('ExitPlanModeReviewAskPermissionPolicyService telemetry', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let records: TelemetryRecord[];
  let mode: PermissionMode;

  beforeEach(() => {
    disposables = new DisposableStore();
    records = [];
    mode = 'manual';
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IAgentPermissionModeService, stubPermissionModeService(() => mode));
        reg.defineInstance(ITelemetryService, recordingTelemetry(records));
      },
    });
  });

  afterEach(() => {
    disposables.dispose();
  });

  function makePolicy(
    exitPlanMode?: ExitPlanModeFn,
  ): ExitPlanModeReviewAskPermissionPolicyService {
    ix.set(IAgentPlanService, planService(exitPlanMode));
    return ix.createInstance(ExitPlanModeReviewAskPermissionPolicyService);
  }

  it('does not ask or track when auto mode approves upstream', async () => {
    mode = 'auto';
    const result = await makePolicy().evaluate(policyContext(planReviewDisplay()));

    expect(result).toBeUndefined();
    expect(records).toEqual([]);
  });

  it('tracks submitted before asking for manual plan approval', async () => {
    const result = await makePolicy().evaluate(policyContext(planReviewDisplay()));

    expect(result?.kind).toBe('ask');
    expect(records).toContainEqual({
      event: 'plan_submitted',
      properties: { has_options: false },
    });
  });

  it('tracks approved multi-option plans with the chosen option', async () => {
    const exitPlanMode = vi.fn();
    const result = await makePolicy(exitPlanMode).evaluate(
      policyContext(planReviewDisplay({ options })),
    );
    if (result?.kind !== 'ask') throw new Error('expected ask');

    const approval = result.resolveApproval?.(approvalResponse({
      decision: 'approved',
      selectedLabel: 'Approach B',
    }));

    expect(approval).toMatchObject({
      kind: 'result',
      syntheticResult: {
        isError: false,
        output: expect.stringContaining('Selected approach: Approach B'),
      },
    });
    expect(exitPlanMode).toHaveBeenCalledTimes(1);
    expect(records).toContainEqual({
      event: 'plan_submitted',
      properties: { has_options: true },
    });
    expect(records).toContainEqual({
      event: 'plan_resolved',
      properties: {
        outcome: 'approved',
        chosen_option: 'Approach B',
      },
    });
  });

  it('handles revision requests with feedback through plan resolution telemetry', async () => {
    const exitPlanMode = vi.fn();
    const result = await makePolicy(exitPlanMode).evaluate(policyContext(planReviewDisplay()));
    if (result?.kind !== 'ask') throw new Error('expected ask');

    const approval = result.resolveApproval?.(approvalResponse({
      decision: 'rejected',
      selectedLabel: 'Revise',
      feedback: 'Add verification.',
    }));

    expect(approval).toMatchObject({
      kind: 'result',
      syntheticResult: {
        isError: false,
        output: expect.stringContaining('Add verification.'),
      },
    });
    expect(exitPlanMode).not.toHaveBeenCalled();
    expect(records).toContainEqual({
      event: 'plan_resolved',
      properties: {
        outcome: 'revise',
        has_feedback: true,
      },
    });
  });

  it('handles plain rejections without exiting plan mode', async () => {
    const exitPlanMode = vi.fn();
    const result = await makePolicy(exitPlanMode).evaluate(policyContext(planReviewDisplay()));
    if (result?.kind !== 'ask') throw new Error('expected ask');

    const approval = result.resolveApproval?.(approvalResponse({ decision: 'rejected' }));

    expect(approval).toMatchObject({
      kind: 'result',
      syntheticResult: {
        isError: true,
        output: 'Plan rejected by user. Plan mode remains active.',
      },
    });
    expect(exitPlanMode).not.toHaveBeenCalled();
    expect(records).toContainEqual({
      event: 'plan_resolved',
      properties: { outcome: 'rejected' },
    });
  });

  it('handles dismissed approval dialogs without exiting plan mode', async () => {
    const exitPlanMode = vi.fn();
    const result = await makePolicy(exitPlanMode).evaluate(policyContext(planReviewDisplay()));
    if (result?.kind !== 'ask') throw new Error('expected ask');

    const approval = result.resolveApproval?.(approvalResponse({ decision: 'cancelled' }));

    expect(approval).toMatchObject({
      kind: 'result',
      syntheticResult: {
        isError: false,
        output: 'Plan approval dismissed. Plan mode remains active.',
      },
    });
    expect(exitPlanMode).not.toHaveBeenCalled();
    expect(records).toContainEqual({
      event: 'plan_resolved',
      properties: { outcome: 'dismissed' },
    });
  });

  it('handles reject-and-exit and exits plan mode', async () => {
    const exitPlanMode = vi.fn();
    const result = await makePolicy(exitPlanMode).evaluate(policyContext(planReviewDisplay()));
    if (result?.kind !== 'ask') throw new Error('expected ask');

    const approval = result.resolveApproval?.(approvalResponse({
      decision: 'rejected',
      selectedLabel: 'Reject and Exit',
    }));

    expect(approval).toMatchObject({
      kind: 'result',
      syntheticResult: {
        isError: true,
        output: 'Plan rejected by user. Plan mode deactivated.',
      },
    });
    expect(exitPlanMode).toHaveBeenCalledTimes(1);
    expect(records).toContainEqual({
      event: 'plan_resolved',
      properties: { outcome: 'rejected_and_exited' },
    });
  });

  it('returns approved plan output without a saved-to line when display has no path', async () => {
    const display: ToolInputDisplay = {
      kind: 'plan_review',
      plan: '# Draft Plan',
    };
    const result = await makePolicy().evaluate(policyContext(display));
    if (result?.kind !== 'ask') throw new Error('expected ask');

    const approval = result.resolveApproval?.(approvalResponse({ decision: 'approved' }));

    expect(approval).toMatchObject({
      kind: 'result',
      syntheticResult: {
        isError: false,
        output: expect.stringContaining('## Approved Plan:\n# Draft Plan'),
      },
    });
    expect(approval?.kind === 'result' ? approval.syntheticResult?.output : '').not.toContain(
      'Plan saved to:',
    );
  });

  it('does not force a selected-approach prefix for labels that are not in the options', async () => {
    const result = await makePolicy().evaluate(policyContext(planReviewDisplay({ options })));
    if (result?.kind !== 'ask') throw new Error('expected ask');

    const approval = result.resolveApproval?.(approvalResponse({
      decision: 'approved',
      selectedLabel: 'Approach C',
    }));

    expect(approval?.kind === 'result' ? approval.syntheticResult?.output : '').not.toContain(
      'Selected approach:',
    );
    expect(records).toContainEqual({
      event: 'plan_resolved',
      properties: {
        outcome: 'approved',
        chosen_option: 'Approach C',
      },
    });
  });

  it('propagates exit errors without tracking approved resolution', async () => {
    const exitPlanMode = vi.fn(() => {
      throw new Error('state transition failure');
    });
    const result = await makePolicy(exitPlanMode).evaluate(policyContext(planReviewDisplay()));
    if (result?.kind !== 'ask') throw new Error('expected ask');

    expect(() => result.resolveApproval?.(approvalResponse({ decision: 'approved' }))).toThrow(
      'state transition failure',
    );
    expect(records).toContainEqual({
      event: 'plan_submitted',
      properties: { has_options: false },
    });
    expect(records).not.toContainEqual({
      event: 'plan_resolved',
      properties: { outcome: 'approved' },
    });
  });
});
