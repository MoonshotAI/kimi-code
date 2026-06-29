import type { ToolCall } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import type { ResolvedToolExecutionHookContext } from '#/loop';
import { DefaultToolApprovePermissionPolicyService } from '#/permissionPolicy/policies/default-tool-approve';
import { ToolAccesses } from '#/tool';

const signal = new AbortController().signal;

function policyContext(toolName: string, args: unknown): ResolvedToolExecutionHookContext {
  return {
    turnId: '0',
    stepNumber: 1,
    signal,
    llm: {},
    args,
    toolCall: {
      type: 'function',
      id: `call_${toolName}`,
      name: toolName,
      arguments: JSON.stringify(args),
    } satisfies ToolCall,
    toolCalls: [
      {
        type: 'function',
        id: `call_${toolName}`,
        name: toolName,
        arguments: JSON.stringify(args),
      },
    ],
    execution: {
      accesses: ToolAccesses.none(),
      approvalRule: toolName,
      execute: async () => ({ output: '' }),
    },
  } as unknown as ResolvedToolExecutionHookContext;
}

describe('DefaultToolApprovePermissionPolicyService', () => {
  const policy = new DefaultToolApprovePermissionPolicyService();

  it('auto-approves CronList', () => {
    expect(policy.evaluate(policyContext('CronList', {}))).toEqual({ kind: 'approve' });
  });

  it('does not approve CronCreate', () => {
    expect(
      policy.evaluate(policyContext('CronCreate', { cron: '*/5 * * * *', prompt: 'ping' })),
    ).toBeUndefined();
  });

  it('does not approve CronDelete', () => {
    expect(policy.evaluate(policyContext('CronDelete', { id: 'job_1' }))).toBeUndefined();
  });

  it('does not approve AgentSwarm', () => {
    expect(
      policy.evaluate(
        policyContext('AgentSwarm', {
          description: 'Check files',
          prompt_template: 'Check {{item}}',
          items: ['a.ts', 'b.ts'],
        }),
      ),
    ).toBeUndefined();
  });
});
