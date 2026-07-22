import type { ToolCall } from '#/kosong/contract/message';
import { describe, expect, it } from 'vitest';

import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { IAgentPlanService, type PlanData } from '#/agent/plan/plan';
import { PlanModeGuardDenyPermissionPolicyService } from '#/agent/permissionPolicy/policies/plan-mode-guard-deny';
import { ToolAccesses } from '#/tool/toolContract';

const signal = new AbortController().signal;
const PLAN_PATH = '/workspace/plan/current-plan.md';

function planService(active: boolean, planFilePath: string | null = PLAN_PATH): IAgentPlanService {
  return {
    _serviceBrand: undefined,
    enter: async () => {},
    cancel: () => {},
    clear: async () => {},
    exit: () => {},
    status: async () =>
      active
        ? ({
            id: 'current-plan',
            content: '# Plan',
            path: planFilePath ?? PLAN_PATH,
          } satisfies NonNullable<PlanData>)
        : null,
  };
}

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return {
    type: 'function',
    id: `call_${name.toLowerCase()}`,
    name,
    arguments: JSON.stringify(args),
  };
}

function policyContext(
  toolName: string,
  args: Record<string, unknown>,
  accesses: ReturnType<typeof ToolAccesses.none> = ToolAccesses.none(),
): ResolvedToolExecutionHookContext {
  const call = toolCall(toolName, args);
  return {
    turnId: 0,
    signal,
    toolCall: call,
    toolCalls: [call],
    args,
    execution: {
      accesses,
      approvalRule: toolName,
      execute: async () => ({ output: '' }),
    },
  };
}

function evaluate(
  policy: PlanModeGuardDenyPermissionPolicyService,
  toolName: string,
  args: Record<string, unknown>,
  accesses?: ReturnType<typeof ToolAccesses.none>,
) {
  return policy.evaluate(policyContext(toolName, args, accesses));
}

function expectDeny(result: Awaited<ReturnType<typeof evaluate>>) {
  expect(result).toMatchObject({ kind: 'deny' });
  if (result?.kind !== 'deny') throw new Error('expected deny result');
  return result;
}

describe('PlanModeGuardDenyPermissionPolicyService', () => {
  it('allows Write and Edit to the active plan file', async () => {
    const policy = new PlanModeGuardDenyPermissionPolicyService(planService(true));

    expect(
      await evaluate(policy, 'Write', { path: PLAN_PATH, content: '# Plan' }, ToolAccesses.writeFile(PLAN_PATH)),
    ).toBeUndefined();
    expect(
      await evaluate(
        policy,
        'Edit',
        { path: PLAN_PATH, old_string: 'A', new_string: 'B' },
        ToolAccesses.readWriteFile(PLAN_PATH),
      ),
    ).toBeUndefined();
  });

  it('blocks Write and Edit to non-plan files before permission approval', async () => {
    const policy = new PlanModeGuardDenyPermissionPolicyService(planService(true));
    const otherPath = '/workspace/src/main.ts';

    const write = await evaluate(
      policy,
      'Write',
      { path: otherPath, content: 'x' },
      ToolAccesses.writeFile(otherPath),
    );
    const edit = await evaluate(
      policy,
      'Edit',
      { path: otherPath, old_string: 'A', new_string: 'B' },
      ToolAccesses.readWriteFile(otherPath),
    );

    expect(expectDeny(write).message).toContain('current plan file');
    expect(expectDeny(write).message).toContain('ExitPlanMode');
    expect(expectDeny(edit).message).toContain('current plan file');
  });

  it('blocks Write and Edit with no file write access while plan mode is active', async () => {
    const policy = new PlanModeGuardDenyPermissionPolicyService(planService(true));

    const write = await evaluate(policy, 'Write', { content: 'x' }, ToolAccesses.none());
    const edit = await evaluate(
      policy,
      'Edit',
      { old_string: 'A', new_string: 'B' },
      ToolAccesses.none(),
    );

    expectDeny(write);
    expectDeny(edit);
  });

  it('allows multiple writes when every write access targets the active plan file', async () => {
    const policy = new PlanModeGuardDenyPermissionPolicyService(planService(true));

    const result = await evaluate(
      policy,
      'Write',
      { path: PLAN_PATH, content: 'x' },
      [
        { kind: 'file', operation: 'write', path: PLAN_PATH },
        { kind: 'file', operation: 'readwrite', path: PLAN_PATH },
      ],
    );

    expect(result).toBeUndefined();
  });

  it('blocks mixed plan-file and non-plan-file write accesses', async () => {
    const policy = new PlanModeGuardDenyPermissionPolicyService(planService(true));

    const result = await evaluate(
      policy,
      'Edit',
      { path: PLAN_PATH, old_string: 'A', new_string: 'B' },
      [
        { kind: 'file', operation: 'readwrite', path: PLAN_PATH },
        { kind: 'file', operation: 'write', path: '/workspace/src/main.ts' },
      ],
    );

    const deny = expectDeny(result);
    expect(deny.message).toContain('current plan file');
  });

  it('does not block read-only tools while plan mode is active', async () => {
    const policy = new PlanModeGuardDenyPermissionPolicyService(planService(true));

    expect(await evaluate(policy, 'Read', { path: '/workspace/src/main.ts' })).toBeUndefined();
    expect(await evaluate(policy, 'Grep', { pattern: 'TODO', path: '/workspace' })).toBeUndefined();
  });

  it.each(['manual', 'yolo', 'auto'] as const)(
    'defers Bash to ordinary %s permission handling while plan mode is active',
    async (_mode) => {
      const policy = new PlanModeGuardDenyPermissionPolicyService(planService(true));

      expect(await evaluate(policy, 'Bash', { command: 'rm foo.txt' })).toBeUndefined();
      expect(await evaluate(policy, 'Bash', { command: 'ls -la' })).toBeUndefined();
    },
  );

  it.each(['manual', 'yolo', 'auto'] as const)(
    'blocks TaskStop while plan mode is active in %s mode',
    async (_mode) => {
      const policy = new PlanModeGuardDenyPermissionPolicyService(planService(true));

      const result = await evaluate(policy, 'TaskStop', { task_id: 'bash-abc12345' });

      const deny = expectDeny(result);
      expect(deny.message).toContain('plan mode');
      expect(deny.message).toContain('ExitPlanMode');
    },
  );

  it('denies CronCreate when plan mode is active', async () => {
    const policy = new PlanModeGuardDenyPermissionPolicyService(planService(true));

    const result = await evaluate(policy, 'CronCreate', {
      cron: '*/5 * * * *',
      prompt: 'ping',
    });

    const deny = expectDeny(result);
    expect(deny.message).toContain('CronCreate');
    expect(deny.message).toContain('plan mode');
  });

  it('denies CronDelete when plan mode is active', async () => {
    const policy = new PlanModeGuardDenyPermissionPolicyService(planService(true));

    const result = await evaluate(policy, 'CronDelete', { id: 'job_1' });

    const deny = expectDeny(result);
    expect(deny.message).toContain('CronDelete');
    expect(deny.message).toContain('plan mode');
  });

  it('allows CronList when plan mode is active', async () => {
    const policy = new PlanModeGuardDenyPermissionPolicyService(planService(true));

    expect(await evaluate(policy, 'CronList', {})).toBeUndefined();
  });

  it('does not block anything once plan mode has exited', async () => {
    const policy = new PlanModeGuardDenyPermissionPolicyService(planService(false));

    expect(
      await evaluate(
        policy,
        'Write',
        { path: '/workspace/src/main.ts', content: 'x' },
        ToolAccesses.writeFile('/workspace/src/main.ts'),
      ),
    ).toBeUndefined();
    expect(await evaluate(policy, 'Bash', { command: 'rm foo.txt' })).toBeUndefined();
    expect(await evaluate(policy, 'TaskStop', { task_id: 'bash-abc12345' })).toBeUndefined();
  });
});
