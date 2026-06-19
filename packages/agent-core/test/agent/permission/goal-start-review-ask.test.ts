import type { ToolCall } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import type { PermissionPolicyContext } from '../../../src/agent/permission';
import type { PermissionMode } from '../../../src/agent/permission';
import { GoalStartReviewAskPermissionPolicy } from '../../../src/agent/permission/policies/goal-start-review-ask';
import type { ToolInputDisplay } from '../../../src/tools/display';
import { ToolAccesses } from '../../../src/loop';

const signal = new AbortController().signal;

function fakeAgent(initialMode: PermissionMode) {
  const permission = {
    mode: initialMode,
    setMode(mode: PermissionMode) {
      this.mode = mode;
    },
  };
  return { agent: { permission } as never, permission };
}

function policyContext(toolName: string, display: ToolInputDisplay | undefined): PermissionPolicyContext {
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
  } as unknown as PermissionPolicyContext;
}

const GOAL_DISPLAY: ToolInputDisplay = {
  kind: 'goal_start',
  objective: 'Fix the failing auth tests',
  mode: 'manual',
};

describe('GoalStartReviewAskPermissionPolicy', () => {
  it('ignores tools other than CreateGoal', () => {
    const { agent } = fakeAgent('manual');
    const policy = new GoalStartReviewAskPermissionPolicy(agent);
    expect(policy.evaluate(policyContext('Bash', undefined))).toBeUndefined();
  });

  it('does not ask in auto mode (the goal is auto-approved upstream)', () => {
    const { agent } = fakeAgent('auto');
    const policy = new GoalStartReviewAskPermissionPolicy(agent);
    expect(policy.evaluate(policyContext('CreateGoal', GOAL_DISPLAY))).toBeUndefined();
  });

  it('does not ask without a goal_start display', () => {
    const { agent } = fakeAgent('manual');
    const policy = new GoalStartReviewAskPermissionPolicy(agent);
    expect(policy.evaluate(policyContext('CreateGoal', undefined))).toBeUndefined();
  });

  it('asks with the start menu for a CreateGoal in manual mode', () => {
    const { agent } = fakeAgent('manual');
    const policy = new GoalStartReviewAskPermissionPolicy(agent);
    const result = policy.evaluate(policyContext('CreateGoal', GOAL_DISPLAY));
    expect(result?.kind).toBe('ask');
  });

  it('switches to the chosen mode on approval, then lets the goal be created', () => {
    const { agent, permission } = fakeAgent('manual');
    const policy = new GoalStartReviewAskPermissionPolicy(agent);
    const result = policy.evaluate(policyContext('CreateGoal', GOAL_DISPLAY));
    if (result?.kind !== 'ask') throw new Error('expected ask');
    // Returning undefined lets CreateGoal.execute run and create the goal.
    expect(result.resolveApproval?.({ decision: 'approved', selectedLabel: 'auto' })).toBeUndefined();
    expect(permission.mode).toBe('auto');
  });

  it('keeps the current mode when the user starts in manual', () => {
    const { agent, permission } = fakeAgent('manual');
    const policy = new GoalStartReviewAskPermissionPolicy(agent);
    const result = policy.evaluate(policyContext('CreateGoal', GOAL_DISPLAY));
    if (result?.kind !== 'ask') throw new Error('expected ask');
    expect(result.resolveApproval?.({ decision: 'approved', selectedLabel: 'manual' })).toBeUndefined();
    expect(permission.mode).toBe('manual');
  });

  it('creates no goal and changes no mode when the user declines', () => {
    const { agent, permission } = fakeAgent('manual');
    const policy = new GoalStartReviewAskPermissionPolicy(agent);
    const result = policy.evaluate(policyContext('CreateGoal', GOAL_DISPLAY));
    if (result?.kind !== 'ask') throw new Error('expected ask');
    // A cancel resolves to undefined; the manager then blocks the tool call.
    expect(result.resolveApproval?.({ decision: 'cancelled', selectedLabel: 'cancel' })).toBeUndefined();
    expect(permission.mode).toBe('manual');
  });
});
