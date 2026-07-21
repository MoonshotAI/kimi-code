import type { ToolCall } from '#/kosong/contract/message';
import { describe, expect, it } from 'vitest';

import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { DefaultToolApprovePermissionPolicyService } from '#/agent/permissionPolicy/policies/default-tool-approve';
import { ToolAccesses } from '#/tool/toolContract';

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

  it.each([
    ['Read', { path: '/workspace/notes.md' }],
    ['Grep', { pattern: 'TODO', path: '/workspace' }],
    ['Glob', { pattern: '**/*.ts', path: '/workspace' }],
    ['ReadMediaFile', { path: '/workspace/image.png' }],
    ['SetTodoList', { items: [] }],
    ['TodoList', {}],
    ['TaskList', {}],
    ['TaskOutput', { task_id: 'task_1' }],
    ['CronList', {}],
    ['WebSearch', { query: 'kimi code' }],
    ['FetchURL', { url: 'https://example.com' }],
    ['Agent', { prompt: 'review this' }],
    ['AskUserQuestion', { questions: [] }],
    ['Skill', { name: 'test-skill' }],
    ['GetGoal', {}],
    ['SetGoalBudget', { tokenBudget: 1000 }],
    ['UpdateGoal', { status: 'complete' }],
  ] as const)('approves %s', (toolName, args) => {
    expect(policy.evaluate(policyContext(toolName, args))).toEqual({ kind: 'approve' });
  });

  it.each([
    ['Bash', { command: 'printf first', timeout: 60 }],
    ['Write', { path: '/workspace/a.ts', content: 'x' }],
    ['Edit', { path: '/workspace/a.ts', old_string: 'a', new_string: 'b' }],
    ['Custom', { value: 1 }],
    ['CronCreate', { cron: '*/5 * * * *', prompt: 'ping' }],
    ['CronDelete', { id: 'job_1' }],
    [
      'AgentSwarm',
      {
        description: 'Check files',
        prompt_template: 'Check {{item}}',
        items: ['a.ts', 'b.ts'],
      },
    ],
  ] as const)('does not approve %s', (toolName, args) => {
    expect(
      policy.evaluate(policyContext(toolName, args)),
    ).toBeUndefined();
  });
});
