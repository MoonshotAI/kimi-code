import type { ToolCall } from '#/kosong/contract/message';
import { describe, expect, it } from 'vitest';

import type { IConfigService } from '#/app/config/config';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { SandboxedBashApprovePermissionPolicyService } from '#/agent/permissionPolicy/policies/sandboxed-bash-approve';
import type { SandboxConfig, SandboxDecision } from '#/session/sandbox/sandboxTypes';

const signal = new AbortController().signal;

const SANDBOXED: SandboxDecision = {
  kind: 'sandboxed',
  argv: ['bwrap', '--', '/bin/bash', '-c', 'ls'],
  backendId: 'bwrap',
};

function stubConfig(section: SandboxConfig | undefined): IConfigService {
  return {
    _serviceBrand: undefined,
    get: (domain: string) => (domain === 'sandbox' ? section : undefined),
  } as unknown as IConfigService;
}

function policyContext(sandbox?: SandboxDecision): ResolvedToolExecutionHookContext {
  const call: ToolCall = {
    type: 'function',
    id: 'call_bash',
    name: 'Bash',
    arguments: JSON.stringify({ command: 'ls' }),
  };
  return {
    turnId: 0,
    signal,
    toolCall: call,
    toolCalls: [call],
    args: { command: 'ls' },
    execution: {
      approvalRule: 'Bash',
      sandbox,
      execute: async () => ({ output: '' }),
    },
  };
}

describe('SandboxedBashApprovePermissionPolicyService', () => {
  function policy(section: SandboxConfig | undefined): SandboxedBashApprovePermissionPolicyService {
    return new SandboxedBashApprovePermissionPolicyService(stubConfig(section));
  }

  it('approves a sandboxed execution when enabled (auto-allow defaults to true)', () => {
    expect(policy({ enabled: true }).evaluate(policyContext(SANDBOXED))).toEqual({
      kind: 'approve',
    });
    expect(
      policy({ enabled: true, autoAllowSandboxedBash: true }).evaluate(policyContext(SANDBOXED)),
    ).toEqual({ kind: 'approve' });
  });

  it('defers when autoAllowSandboxedBash is false', () => {
    expect(
      policy({ enabled: true, autoAllowSandboxedBash: false }).evaluate(policyContext(SANDBOXED)),
    ).toBeUndefined();
  });

  it('defers when the execution is not sandboxed', () => {
    expect(
      policy({ enabled: true }).evaluate(
        policyContext({ kind: 'unsandboxed', reason: 'backend-unavailable' }),
      ),
    ).toBeUndefined();
    expect(
      policy({ enabled: true }).evaluate(policyContext({ kind: 'excluded', matched: 'docker' })),
    ).toBeUndefined();
    expect(policy({ enabled: true }).evaluate(policyContext())).toBeUndefined();
  });

  it('defers when the sandbox is disabled or unconfigured', () => {
    expect(policy({ enabled: false }).evaluate(policyContext(SANDBOXED))).toBeUndefined();
    expect(policy({}).evaluate(policyContext(SANDBOXED))).toBeUndefined();
    expect(policy(undefined).evaluate(policyContext(SANDBOXED))).toBeUndefined();
  });
});
