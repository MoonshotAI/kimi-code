import type { ToolCall } from '#/kosong/contract/message';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';
import { describe, expect, it } from 'vitest';

import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import type { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { GoalStartReviewAskPermissionPolicyService } from '#/agent/permissionPolicy/policies/goal-start-review-ask';
import { ToolAccesses } from '#/tool/toolContract';

const signal = new AbortController().signal;
type PermissionMode = IAgentPermissionModeService['mode'];

function fakeModeService(initialMode: PermissionMode) {
  let currentMode = initialMode;
  return {
    get mode() {
      return currentMode;
    },
    setMode(mode: PermissionMode) {
      currentMode = mode;
    },
  } as IAgentPermissionModeService;
}

function policyContext(
  toolName: string,
  display: ToolInputDisplay | undefined,
): ResolvedToolExecutionHookContext {
  return {
    turnId: '0',
    stepNumber: 1,
    signal,
    llm: {},
    args: {},
    toolCall: {
      type: 'function',
      id: `call_${toolName}`,
      name: toolName,
      arguments: '{}',
    } satisfies ToolCall,
    execution: {
      accesses: ToolAccesses.none(),
      approvalRule: toolName,
      display,
      execute: async () => ({ output: '' }),
    },
  } as unknown as ResolvedToolExecutionHookContext;
}

const GOAL_DISPLAY: ToolInputDisplay = {
  kind: 'goal_start',
  objective: 'Fix the failing auth tests',
  mode: 'manual',
};

describe('GoalStartReviewAskPermissionPolicyService', () => {
  it('ignores tools other than CreateGoal', () => {
    const mode = fakeModeService('manual');
    const policy = new GoalStartReviewAskPermissionPolicyService(mode);
    expect(policy.evaluate(policyContext('Bash', undefined))).toBeUndefined();
  });

  it('does not ask in auto mode (the goal is auto-approved upstream)', () => {
    const mode = fakeModeService('auto');
    const policy = new GoalStartReviewAskPermissionPolicyService(mode);
    expect(policy.evaluate(policyContext('CreateGoal', GOAL_DISPLAY))).toBeUndefined();
  });

  it('does not ask without a goal_start display', () => {
    const mode = fakeModeService('manual');
    const policy = new GoalStartReviewAskPermissionPolicyService(mode);
    expect(policy.evaluate(policyContext('CreateGoal', undefined))).toBeUndefined();
  });

  it('asks with the start menu for a CreateGoal in manual mode', () => {
    const mode = fakeModeService('manual');
    const policy = new GoalStartReviewAskPermissionPolicyService(mode);
    const result = policy.evaluate(policyContext('CreateGoal', GOAL_DISPLAY));
    expect(result?.kind).toBe('ask');
  });

  it('switches to the chosen mode on approval, then lets the goal be created', () => {
    const mode = fakeModeService('manual');
    const policy = new GoalStartReviewAskPermissionPolicyService(mode);
    const result = policy.evaluate(policyContext('CreateGoal', GOAL_DISPLAY));
    if (result?.kind !== 'ask') throw new Error('expected ask');
    expect(result.resolveApproval?.({ decision: 'approved', selectedLabel: 'auto' })).toBeUndefined();
    expect(mode.mode).toBe('auto');
  });

  it('keeps the current mode when the user starts in manual', () => {
    const mode = fakeModeService('manual');
    const policy = new GoalStartReviewAskPermissionPolicyService(mode);
    const result = policy.evaluate(policyContext('CreateGoal', GOAL_DISPLAY));
    if (result?.kind !== 'ask') throw new Error('expected ask');
    expect(result.resolveApproval?.({ decision: 'approved', selectedLabel: 'manual' })).toBeUndefined();
    expect(mode.mode).toBe('manual');
  });

  it('creates no goal and changes no mode when the user declines', () => {
    const mode = fakeModeService('manual');
    const policy = new GoalStartReviewAskPermissionPolicyService(mode);
    const result = policy.evaluate(policyContext('CreateGoal', GOAL_DISPLAY));
    if (result?.kind !== 'ask') throw new Error('expected ask');
    expect(result.resolveApproval?.({ decision: 'cancelled', selectedLabel: 'cancel' })).toBeUndefined();
    expect(mode.mode).toBe('manual');
  });
});
