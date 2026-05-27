import type { ToolCall } from '@moonshot-ai/kosong';
import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../src/agent';
import type {
  PermissionMode,
  PermissionPolicyContext,
  PermissionPolicyResult,
} from '../../src/agent/permission';
import { PlanModeGuardDenyPermissionPolicy } from '../../src/agent/permission/policies/plan-mode-guard-deny';
import { PlanMode } from '../../src/agent/plan';
import { ToolAccesses } from '../../src/loop';
import type { ToolExecutionHookContext } from '../../src/loop';

const signal = new AbortController().signal;

async function activePlanAgent(): Promise<{ agent: Agent; planMode: PlanMode }> {
  const agent = {
    homedir: '/tmp/kimi-plan-test',
    emitStatusUpdated: vi.fn(),
    records: { logRecord: vi.fn() },
    replayBuilder: { push: vi.fn() },
    runtime: {
      kaos: {
        mkdir: vi.fn().mockResolvedValue(undefined),
      },
    },
  } as unknown as Agent;
  const planMode = new PlanMode(agent);
  Object.assign(agent, { planMode });
  await planMode.enter('current-plan', false);
  return { agent, planMode };
}

function hookContext(toolName: string, args: unknown): ToolExecutionHookContext {
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
  } as ToolExecutionHookContext;
}

function policyContext(
  toolName: string,
  args: unknown,
  _mode: PermissionMode = 'manual',
  accesses = toolAccesses(toolName, args),
): PermissionPolicyContext {
  return {
    ...hookContext(toolName, args),
    execution: {
      accesses,
      approvalRule: toolName,
      execute: async () => ({ output: '' }),
    },
  };
}

function evaluatePlanPolicy(
  agent: Agent,
  toolName: string,
  args: unknown,
  mode: PermissionMode = 'manual',
) {
  return new PlanModeGuardDenyPermissionPolicy(agent).evaluate(policyContext(toolName, args, mode));
}

describe('Plan mode permission policy', () => {
  it('allows Write and Edit to the active plan file', async () => {
    const { agent, planMode } = await activePlanAgent();
    const planPath = planMode.planFilePath;
    if (planPath === null) throw new Error('expected plan path');

    expect(evaluatePlanPolicy(agent, 'Write', { path: planPath })).toBeUndefined();
    expect(
      evaluatePlanPolicy(
        agent,
        'Edit',
        {
          path: planPath,
          old_string: 'A',
          new_string: 'B',
        },
      ),
    ).toBeUndefined();
  });

  it('blocks Write and Edit to non-plan files before permission approval', async () => {
    const { agent } = await activePlanAgent();

    const write = evaluatePlanPolicy(agent, 'Write', {
      path: '/workspace/src/main.ts',
      content: 'x',
    });
    const edit = evaluatePlanPolicy(agent, 'Edit', {
      path: '/workspace/src/main.ts',
      old_string: 'A',
      new_string: 'B',
    });

    const writeDeny = expectDeny(write);
    expect(writeDeny.message ?? '').toContain('current plan file');
    expect(writeDeny.message ?? '').toContain('ExitPlanMode');
    const editDeny = expectDeny(edit);
    expect(editDeny.message ?? '').toContain('current plan file');
  });

  it('blocks file edits when plan mode has no selected plan file path', async () => {
    const { agent, planMode } = await activePlanAgent();
    (planMode as unknown as { _planFilePath: string | null })._planFilePath = null;

    const result = evaluatePlanPolicy(agent, 'Edit', {
      path: '/workspace/src/other.ts',
      old_string: 'A',
      new_string: 'B',
    });

    const deny = expectDeny(result);
    expect(deny.message ?? '').toContain('(no plan file selected yet)');
    expect(deny.message ?? '').toContain('ExitPlanMode');
  });

  it('blocks file writes when plan mode has no selected plan file path', async () => {
    const { agent, planMode } = await activePlanAgent();
    (planMode as unknown as { _planFilePath: string | null })._planFilePath = null;

    const result = evaluatePlanPolicy(agent, 'Write', {
      path: '/workspace/src/other.ts',
      content: 'x',
    });

    const deny = expectDeny(result);
    expect(deny.message ?? '').toContain('(no plan file selected yet)');
    expect(deny.message ?? '').toContain('ExitPlanMode');
  });

  it('blocks Write and Edit with no file write access while plan mode is active', async () => {
    const { agent } = await activePlanAgent();

    const write = new PlanModeGuardDenyPermissionPolicy(agent).evaluate(
      policyContext('Write', { content: 'x' }, 'manual', ToolAccesses.none()),
    );
    const edit = new PlanModeGuardDenyPermissionPolicy(agent).evaluate(
      policyContext(
        'Edit',
        { old_string: 'A', new_string: 'B' },
        'manual',
        ToolAccesses.none(),
      ),
    );

    expectDeny(write);
    expectDeny(edit);
  });

  it('allows multiple writes when every write access targets the active plan file', async () => {
    const { agent, planMode } = await activePlanAgent();
    const planPath = planMode.planFilePath;
    if (planPath === null) throw new Error('expected plan path');

    const result = new PlanModeGuardDenyPermissionPolicy(agent).evaluate(
      policyContext(
        'Write',
        { path: planPath, content: 'x' },
        'manual',
        [
          { kind: 'file', operation: 'write', path: planPath },
          { kind: 'file', operation: 'readwrite', path: planPath },
        ],
      ),
    );

    expect(result).toBeUndefined();
  });

  it('blocks mixed plan-file and non-plan-file write accesses', async () => {
    const { agent, planMode } = await activePlanAgent();
    const planPath = planMode.planFilePath;
    if (planPath === null) throw new Error('expected plan path');

    const result = new PlanModeGuardDenyPermissionPolicy(agent).evaluate(
      policyContext(
        'Edit',
        { path: planPath, old_string: 'A', new_string: 'B' },
        'manual',
        [
          { kind: 'file', operation: 'readwrite', path: planPath },
          { kind: 'file', operation: 'write', path: '/workspace/src/main.ts' },
        ],
      ),
    );

    const deny = expectDeny(result);
    expect(deny.message ?? '').toContain('current plan file');
  });

  it('does not block read-only tools while plan mode is active', async () => {
    const { agent } = await activePlanAgent();

    expect(evaluatePlanPolicy(agent, 'Read', { path: '/workspace/src/main.ts' })).toBeUndefined();
    expect(evaluatePlanPolicy(agent, 'Grep', { pattern: 'TODO', path: '/workspace' })).toBeUndefined();
  });

  it.each(['manual', 'yolo', 'auto'] as const)(
    'defers Bash to ordinary %s permission handling while plan mode is active',
    async (mode) => {
      const { agent } = await activePlanAgent();

      expect(evaluatePlanPolicy(agent, 'Bash', { command: 'rm foo.txt' }, mode)).toBeUndefined();
      expect(evaluatePlanPolicy(agent, 'Bash', { command: 'ls -la' }, mode)).toBeUndefined();
    },
  );

  it.each(['manual', 'yolo', 'auto'] as const)(
    'blocks TaskStop while plan mode is active in %s mode',
    async (mode) => {
      const { agent } = await activePlanAgent();

      const result = evaluatePlanPolicy(
        agent,
        'TaskStop',
        { task_id: 'bash-abc12345' },
        mode,
      );

      const deny = expectDeny(result);
      expect(deny.message ?? '').toContain('plan mode');
      expect(deny.message ?? '').toContain('ExitPlanMode');
    },
  );

  it('does not block anything once plan mode has exited', async () => {
    const { agent, planMode } = await activePlanAgent();
    planMode.exit();

    expect(evaluatePlanPolicy(agent, 'Write', { path: '/workspace/src/main.ts' })).toBeUndefined();
    expect(evaluatePlanPolicy(agent, 'Bash', { command: 'rm foo.txt' })).toBeUndefined();
    expect(evaluatePlanPolicy(agent, 'TaskStop', { task_id: 'bash-abc12345' })).toBeUndefined();
  });
});

function toolAccesses(toolName: string, args: unknown) {
  const path = args !== null && typeof args === 'object' ? (args as { path?: unknown }).path : undefined;
  if (typeof path !== 'string') return ToolAccesses.none();
  if (toolName === 'Write') return ToolAccesses.writeFile(path);
  if (toolName === 'Edit') return ToolAccesses.readWriteFile(path);
  return ToolAccesses.none();
}

function expectDeny(
  result: PermissionPolicyResult | undefined,
): Extract<PermissionPolicyResult, { kind: 'deny' }> {
  expect(result).toMatchObject({ kind: 'deny' });
  if (result?.kind !== 'deny') throw new Error('expected deny result');
  return result;
}
