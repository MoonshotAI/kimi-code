import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ToolCall } from '#/kosong/contract/message';
import { afterEach, describe, expect, it } from 'vitest';

import type { IConfigService } from '#/app/config/config';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { SandboxFsDenyPermissionPolicyService } from '#/agent/permissionPolicy/policies/sandbox-fs-deny';
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
  workDir = '/workspace/app',
  additionalDirs: readonly string[] = ['/workspace/extra'],
): SandboxFsDenyPermissionPolicyService {
  return new SandboxFsDenyPermissionPolicyService(
    stubConfig(section),
    stubWorkspaceContext(workDir, additionalDirs),
    stubEnv(),
  );
}

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-sandbox-fs-deny-'));
  tempDirs.push(dir);
  return dir;
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

describe('SandboxFsDenyPermissionPolicyService', () => {
  it('denies reads under a deny_read subtree rule, including /foo-evil escape resistance', () => {
    const p = policy({ enabled: true, filesystem: { denyRead: ['~/.ssh/**'] } });

    expect(
      p.evaluate(policyContext(ToolAccesses.readFile('/home/test/.ssh/config'))),
    ).toMatchObject({ kind: 'deny' });
    expect(
      p.evaluate(policyContext(ToolAccesses.readFile('/home/test/.ssh2/config'))),
    ).toBeUndefined();
  });

  it('denies searches under a deny_read rule', () => {
    const p = policy({ enabled: true, filesystem: { denyRead: ['/home/test/.gnupg'] } });

    expect(
      p.evaluate(policyContext(ToolAccesses.searchTree('/home/test/.gnupg/keyring'))),
    ).toMatchObject({ kind: 'deny' });
    expect(
      p.evaluate(policyContext(ToolAccesses.searchTree('/home/test/other'))),
    ).toBeUndefined();
  });

  it('treats a deny_read entry without /** as an exact file (no suffix leakage)', () => {
    const p = policy({ enabled: true, filesystem: { denyRead: ['/home/test/secrets.txt'] } });

    expect(
      p.evaluate(policyContext(ToolAccesses.readFile('/home/test/secrets.txt'))),
    ).toMatchObject({ kind: 'deny' });
    expect(
      p.evaluate(policyContext(ToolAccesses.readFile('/home/test/secrets.txt.bak'))),
    ).toBeUndefined();
  });

  it('denies readwrite accesses against deny_read (readwrite reads too)', () => {
    const p = policy({ enabled: true, filesystem: { denyRead: ['/home/test/secrets.txt'] } });

    expect(
      p.evaluate(policyContext(ToolAccesses.readWriteFile('/home/test/secrets.txt'))),
    ).toMatchObject({ kind: 'deny' });
  });

  it('denies writes under a deny_write rule', () => {
    const p = policy({ enabled: true, filesystem: { denyWrite: ['/workspace/app/.git/**'] } });

    expect(
      p.evaluate(policyContext(ToolAccesses.writeFile('/workspace/app/.git/config'))),
    ).toMatchObject({ kind: 'deny' });
    expect(
      p.evaluate(policyContext(ToolAccesses.writeFile('/workspace/app/.gitx/config'))),
    ).toBeUndefined();
    expect(
      p.evaluate(policyContext(ToolAccesses.writeFile('/workspace/app/src/a.ts'))),
    ).toBeUndefined();
  });

  it('denies writes outside the writable roots in read-only mode', () => {
    const p = policy({ enabled: true, mode: 'read-only' });

    expect(
      p.evaluate(policyContext(ToolAccesses.writeFile('/workspace/app/src/a.ts'))),
    ).toMatchObject({ kind: 'deny', reason: { sandbox_mode: 'read-only' } });
    expect(
      p.evaluate(policyContext(ToolAccesses.writeFile(`${tmpdir()}/scratch.txt`))),
    ).toBeUndefined();
    expect(
      p.evaluate(policyContext(ToolAccesses.readFile('/workspace/app/src/a.ts'))),
    ).toBeUndefined();
  });

  it('allows writes inside the workspace in workspace-write mode', () => {
    const p = policy({ enabled: true });

    expect(
      p.evaluate(policyContext(ToolAccesses.writeFile('/workspace/app/src/a.ts'))),
    ).toBeUndefined();
    expect(
      p.evaluate(policyContext(ToolAccesses.writeFile('/workspace/extra/b.ts'))),
    ).toBeUndefined();
  });

  it('denies sensitive files for any operation (ask upgraded to deny)', () => {
    const p = policy({ enabled: true });

    expect(
      p.evaluate(policyContext(ToolAccesses.readFile('/home/test/.ssh/id_rsa'))),
    ).toMatchObject({ kind: 'deny' });
    expect(
      p.evaluate(policyContext(ToolAccesses.writeFile('/workspace/app/.env'))),
    ).toMatchObject({ kind: 'deny' });
    expect(
      p.evaluate(policyContext(ToolAccesses.readFile('/workspace/app/.env.example'))),
    ).toBeUndefined();
  });

  it('defers when the sandbox is disabled or there are no file accesses', () => {
    expect(
      policy({ enabled: false }).evaluate(
        policyContext(ToolAccesses.readFile('/home/test/.ssh/id_rsa')),
      ),
    ).toBeUndefined();
    expect(
      policy(undefined).evaluate(policyContext(ToolAccesses.readFile('/home/test/.ssh/id_rsa'))),
    ).toBeUndefined();
    expect(policy({ enabled: true }).evaluate(policyContext(ToolAccesses.none()))).toBeUndefined();
  });

  it('denies a recursive search whose root contains a deny_read directory', () => {
    const ws = makeTempDir();
    const secret = join(ws, 'secret');
    mkdirSync(secret);
    const p = policy({ enabled: true, filesystem: { denyRead: [secret] } }, ws);

    const denied = p.evaluate(policyContext(ToolAccesses.searchTree(ws)));
    expect(denied).toMatchObject({ kind: 'deny', reason: { matched_rule: secret } });
    expect(denied?.kind === 'deny' && denied.message).toContain('Narrow');

    expect(p.evaluate(policyContext(ToolAccesses.readTree(ws)))).toMatchObject({
      kind: 'deny',
      reason: { matched_rule: secret },
    });
  });

  it('does not deny recursive searches that only contain deny_read files or nothing denied', () => {
    const ws = makeTempDir();
    writeFileSync(join(ws, '.env'), 'SECRET=1');
    const p = policy({ enabled: true }, ws);

    expect(p.evaluate(policyContext(ToolAccesses.searchTree(ws)))).toBeUndefined();
  });

  it('does not apply reverse containment to non-recursive accesses', () => {
    const ws = makeTempDir();
    const secret = join(ws, 'secret');
    mkdirSync(secret);
    const p = policy({ enabled: true, filesystem: { denyRead: [secret] } }, ws);

    expect(
      p.evaluate(policyContext(ToolAccesses.readFile(join(ws, 'other.txt')))),
    ).toBeUndefined();
    expect(
      p.evaluate(policyContext([{ kind: 'file', operation: 'search', path: ws }])),
    ).toBeUndefined();
  });
});
