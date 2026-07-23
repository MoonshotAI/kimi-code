import { tmpdir } from 'node:os';

import type { ToolCall } from '#/kosong/contract/message';
import { describe, expect, it } from 'vitest';

import type { IConfigService } from '#/app/config/config';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { SandboxOutsideWorkspaceAskPermissionPolicyService } from '#/agent/permissionPolicy/policies/sandbox-outside-workspace-ask';
import type { IHostEnvironment } from '#/os/interface/hostEnvironment';
import type { SandboxConfig } from '#/session/sandbox/sandboxTypes';
import { ToolAccesses, type ToolAccesses as ToolAccessList } from '#/tool/toolContract';

import { stubWorkspaceContext } from '../../../session/workspaceContext/stub-workspace-context';

const signal = new AbortController().signal;

function stubConfig(section: SandboxConfig | undefined): IConfigService {
  return {
    _serviceBrand: undefined,
    get: (domain: string) => (domain === 'sandbox' ? section : undefined),
  } as unknown as IConfigService;
}

function stubEnv(): IHostEnvironment {
  return {
    _serviceBrand: undefined,
    osKind: 'Linux',
    osArch: 'x86_64',
    osVersion: 'test',
    shellName: 'bash',
    shellPath: '/bin/bash',
    pathClass: 'posix',
    homeDir: '/home/test',
    ready: Promise.resolve(),
  };
}

function policy(
  section: SandboxConfig | undefined,
): SandboxOutsideWorkspaceAskPermissionPolicyService {
  return new SandboxOutsideWorkspaceAskPermissionPolicyService(
    stubConfig(section),
    stubWorkspaceContext('/workspace/app', ['/workspace/extra']),
    stubEnv(),
  );
}

function policyContext(accesses: ToolAccessList): ResolvedToolExecutionHookContext {
  const call: ToolCall = {
    type: 'function',
    id: 'call_tool',
    name: 'Read',
    arguments: '{}',
  };
  return {
    turnId: 0,
    signal,
    toolCall: call,
    toolCalls: [call],
    args: {},
    execution: {
      approvalRule: 'Read',
      accesses,
      execute: async () => ({ output: '' }),
    },
  };
}

describe('SandboxOutsideWorkspaceAskPermissionPolicyService', () => {
  it('asks for reads, writes, and searches outside the writable roots', () => {
    const p = policy({ enabled: true });

    expect(
      p.evaluate(policyContext(ToolAccesses.readFile('/etc/hosts'))),
    ).toEqual({ kind: 'ask' });
    expect(
      p.evaluate(policyContext(ToolAccesses.writeFile('/etc/sandbox-probe.conf'))),
    ).toEqual({ kind: 'ask' });
    expect(
      p.evaluate(policyContext(ToolAccesses.searchTree('/var/log'))),
    ).toEqual({ kind: 'ask' });
  });

  it('defers for paths inside the workspace, additional dirs, tmpdir, and allow_write roots', () => {
    const p = policy({ enabled: true, filesystem: { allowWrite: ['/data/out'] } });

    expect(
      p.evaluate(policyContext(ToolAccesses.readFile('/workspace/app/src/a.ts'))),
    ).toBeUndefined();
    expect(
      p.evaluate(policyContext(ToolAccesses.writeFile('/workspace/extra/b.ts'))),
    ).toBeUndefined();
    expect(
      p.evaluate(policyContext(ToolAccesses.writeFile(`${tmpdir()}/scratch.txt`))),
    ).toBeUndefined();
    expect(
      p.evaluate(policyContext(ToolAccesses.writeFile('/data/out/result.txt'))),
    ).toBeUndefined();
  });

  it('does not leak on shared-prefix paths outside the roots', () => {
    const p = policy({ enabled: true });

    expect(
      p.evaluate(policyContext(ToolAccesses.readFile('/workspace/app-evil/secret.txt'))),
    ).toEqual({ kind: 'ask' });
  });

  it('defers when the sandbox is disabled or there are no file accesses', () => {
    expect(
      policy({ enabled: false }).evaluate(policyContext(ToolAccesses.readFile('/etc/hosts'))),
    ).toBeUndefined();
    expect(
      policy(undefined).evaluate(policyContext(ToolAccesses.readFile('/etc/hosts'))),
    ).toBeUndefined();
    expect(policy({ enabled: true }).evaluate(policyContext(ToolAccesses.none()))).toBeUndefined();
  });
});
