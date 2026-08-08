import type { ToolCall } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import type { PermissionPolicyContext } from '../../../src/agent/permission';
import { TowerWorkerWriteGuardPermissionPolicy } from '../../../src/agent/permission/policies/tower-worker-write-guard-deny';
import type { ToolFileAccess } from '../../../src/loop/tool-access';

const signal = new AbortController().signal;
const WORKTREE = '/repo/.tower/worktrees/wt-1';

function fakeAgent(profileName: string, cwd: string) {
  return { config: { profileName, cwd } } as never;
}

function writeContext(toolName: string, paths: readonly string[]): PermissionPolicyContext {
  const accesses: ToolFileAccess[] = paths.map((path) => ({
    kind: 'file',
    path,
    operation: 'write',
  }));
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
      accesses,
      approvalRule: toolName,
      execute: async () => ({ output: '' }),
    },
  } as unknown as PermissionPolicyContext;
}

describe('TowerWorkerWriteGuardPermissionPolicy', () => {
  it('ignores agents that are not tower workers', () => {
    const policy = new TowerWorkerWriteGuardPermissionPolicy(fakeAgent('coder', WORKTREE));
    expect(
      policy.evaluate(writeContext('Write', ['/repo/src/main.ts'])),
    ).toBeUndefined();
  });

  it('ignores non-write tools', () => {
    const policy = new TowerWorkerWriteGuardPermissionPolicy(
      fakeAgent('tower-worker', WORKTREE),
    );
    expect(policy.evaluate(writeContext('Bash', []))).toBeUndefined();
    expect(policy.evaluate(writeContext('Read', []))).toBeUndefined();
  });

  it('allows writes inside the worktree', () => {
    const policy = new TowerWorkerWriteGuardPermissionPolicy(
      fakeAgent('tower-worker', WORKTREE),
    );
    expect(
      policy.evaluate(writeContext('Write', [`${WORKTREE}/src/layer/gemm.cpp`])),
    ).toBeUndefined();
  });

  it('denies writes to the main checkout via absolute path', () => {
    const policy = new TowerWorkerWriteGuardPermissionPolicy(
      fakeAgent('tower-worker', WORKTREE),
    );
    const result = policy.evaluate(writeContext('Write', ['/repo/src/layer/gemm.cpp']));
    expect(result?.kind).toBe('deny');
    if (result?.kind === 'deny') {
      expect(result.message).toContain('/repo/src/layer/gemm.cpp');
      expect(result.message).toContain('TowerFinding');
    }
  });

  it('denies sibling worktree slots and path-prefix tricks', () => {
    const policy = new TowerWorkerWriteGuardPermissionPolicy(
      fakeAgent('tower-worker', WORKTREE),
    );
    expect(
      policy.evaluate(writeContext('Edit', ['/repo/.tower/worktrees/wt-2/src/x.ts']))?.kind,
    ).toBe('deny');
    // `/repo/.tower/worktrees/wt-10` shares a string prefix with wt-1 but is not inside it.
    expect(
      policy.evaluate(writeContext('Write', ['/repo/.tower/worktrees/wt-10/src/x.ts']))?.kind,
    ).toBe('deny');
  });

  it('denies when any one of several targets escapes', () => {
    const policy = new TowerWorkerWriteGuardPermissionPolicy(
      fakeAgent('tower-worker', WORKTREE),
    );
    const result = policy.evaluate(
      writeContext('Edit', [`${WORKTREE}/ok.ts`, '/tmp/escape.ts']),
    );
    expect(result?.kind).toBe('deny');
  });
});
