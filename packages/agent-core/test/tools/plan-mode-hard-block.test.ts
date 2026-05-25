import type { ToolCall } from '@moonshot-ai/kosong';
import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../src/agent';
import { PlanModeGuardPermissionPolicy } from '../../src/agent/permission/policies/plan';
import type { PermissionMode } from '../../src/agent/permission/types';
import type { PermissionPolicyContext } from '../../src/agent/permission/policy';
import { PlanMode } from '../../src/agent/plan';
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
      function: {
        name: toolName,
        arguments: JSON.stringify(args),
      },
    } satisfies ToolCall,
  } as ToolExecutionHookContext;
}

function policyContext(
  toolName: string,
  args: unknown,
  _mode: PermissionMode = 'manual',
): PermissionPolicyContext {
  return {
    ...hookContext(toolName, args),
    matchedRule: undefined,
  };
}

function evaluatePlanPolicy(
  agent: Agent,
  toolName: string,
  args: unknown,
  mode: PermissionMode = 'manual',
) {
  return new PlanModeGuardPermissionPolicy(agent).evaluate(policyContext(toolName, args, mode));
}

describe('Plan mode permission policy', () => {
  it('allows Write and Edit to the active plan file', async () => {
    const { agent, planMode } = await activePlanAgent();
    const planPath = planMode.planFilePath;
    if (planPath === null) throw new Error('expected plan path');

    expect(
      await evaluatePlanPolicy(agent, 'Write', { path: planPath }),
    ).toEqual({ kind: 'allow' });
    expect(
      await evaluatePlanPolicy(
        agent,
        'Edit',
        {
          path: planPath,
          old_string: 'A',
          new_string: 'B',
        },
      ),
    ).toEqual({ kind: 'allow' });
  });

  it('blocks Write and Edit to non-plan files before permission approval', async () => {
    const { agent } = await activePlanAgent();

    const write = await evaluatePlanPolicy(agent, 'Write', {
      path: '/workspace/src/main.ts',
      content: 'x',
    });
    const edit = await evaluatePlanPolicy(agent, 'Edit', {
      path: '/workspace/src/main.ts',
      old_string: 'A',
      new_string: 'B',
    });

    expect(write).toMatchObject({ kind: 'result', block: true });
    expect(write?.kind === 'result' ? write.reason : '').toContain('current plan file');
    expect(write?.kind === 'result' ? write.reason : '').toContain('ExitPlanMode');
    expect(edit).toMatchObject({ kind: 'result', block: true });
    expect(edit?.kind === 'result' ? edit.reason : '').toContain('current plan file');
  });

  it('blocks file edits when plan mode has no selected plan file path', async () => {
    const { agent, planMode } = await activePlanAgent();
    (planMode as unknown as { _planFilePath: string | null })._planFilePath = null;

    const result = await evaluatePlanPolicy(agent, 'Edit', {
      path: '/workspace/src/other.ts',
      old_string: 'A',
      new_string: 'B',
    });

    expect(result).toMatchObject({ kind: 'result', block: true });
    expect(result?.kind === 'result' ? result.reason : '').toContain(
      '(no plan file selected yet)',
    );
    expect(result?.kind === 'result' ? result.reason : '').toContain('ExitPlanMode');
  });

  it.each(['manual', 'yolo', 'auto'] as const)(
    'defers Bash to ordinary %s permission handling while plan mode is active',
    async (mode) => {
      const { agent } = await activePlanAgent();

      expect(
        await evaluatePlanPolicy(agent, 'Bash', { command: 'rm foo.txt' }, mode),
      ).toBeUndefined();
      expect(
        await evaluatePlanPolicy(agent, 'Bash', { command: 'ls -la' }, mode),
      ).toBeUndefined();
    },
  );

  it.each(['manual', 'yolo', 'auto'] as const)(
    'blocks TaskStop while plan mode is active in %s mode',
    async (mode) => {
      const { agent } = await activePlanAgent();

      const result = await evaluatePlanPolicy(
        agent,
        'TaskStop',
        { task_id: 'bash-abc12345' },
        mode,
      );

      expect(result).toMatchObject({ kind: 'result', block: true });
      expect(result?.kind === 'result' ? result.reason : '').toContain('plan mode');
      expect(result?.kind === 'result' ? result.reason : '').toContain('ExitPlanMode');
    },
  );

  it('does not block anything once plan mode has exited', async () => {
    const { agent, planMode } = await activePlanAgent();
    planMode.exit();

    expect(
      await evaluatePlanPolicy(agent, 'Write', { path: '/workspace/src/main.ts' }),
    ).toBeUndefined();
    expect(
      await evaluatePlanPolicy(agent, 'Bash', { command: 'rm foo.txt' }),
    ).toBeUndefined();
    expect(
      await evaluatePlanPolicy(agent, 'TaskStop', { task_id: 'bash-abc12345' }),
    ).toBeUndefined();
  });
});
