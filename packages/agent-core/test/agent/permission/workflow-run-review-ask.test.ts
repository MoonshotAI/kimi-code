import type { ToolCall } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import type { PermissionMode, PermissionPolicyContext } from '../../../src/agent/permission';
import { WorkflowRunReviewAskPermissionPolicy } from '../../../src/agent/permission/policies/workflow-run-review-ask';
import type { ToolInputDisplay } from '../../../src/tools/display';
import { ToolAccesses } from '../../../src/loop';

const signal = new AbortController().signal;

function fakeAgent(mode: PermissionMode) {
  return { permission: { mode } } as never;
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

const WORKFLOW_DISPLAY: ToolInputDisplay = {
  kind: 'workflow_run',
  workflow_name: 'deep-research',
  description: 'Deep research harness.',
  phases: [{ title: 'Scope' }],
  script: 'export const meta = {};',
  source: 'builtin',
  limits: { max_concurrency: 4, max_agent_calls: 50, max_duration_ms: 1_800_000 },
  consumption_warning: 'warning',
};

describe('WorkflowRunReviewAskPermissionPolicy', () => {
  it('ignores tools other than Workflow', () => {
    const policy = new WorkflowRunReviewAskPermissionPolicy(fakeAgent('manual'));
    expect(policy.evaluate(policyContext('Bash', undefined))).toBeUndefined();
  });

  it('does not ask without a workflow_run display', () => {
    const policy = new WorkflowRunReviewAskPermissionPolicy(fakeAgent('manual'));
    expect(policy.evaluate(policyContext('Workflow', undefined))).toBeUndefined();
  });

  it('asks for a Workflow call in manual mode', () => {
    const policy = new WorkflowRunReviewAskPermissionPolicy(fakeAgent('manual'));
    const result = policy.evaluate(policyContext('Workflow', WORKFLOW_DISPLAY));
    expect(result?.kind).toBe('ask');
  });

  it('skips (lets downstream approve) in auto mode', () => {
    const policy = new WorkflowRunReviewAskPermissionPolicy(fakeAgent('auto'));
    expect(policy.evaluate(policyContext('Workflow', WORKFLOW_DISPLAY))).toBeUndefined();
  });

  it('skips (lets downstream approve) in yolo mode', () => {
    const policy = new WorkflowRunReviewAskPermissionPolicy(fakeAgent('yolo'));
    expect(policy.evaluate(policyContext('Workflow', WORKFLOW_DISPLAY))).toBeUndefined();
  });
});
