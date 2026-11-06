import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IConfigService } from '#/app/config/config';
import { IAgentPermissionRulesService, type PermissionApprovalResultRecord, type PermissionRule } from '#/agent/permissionRules/permissionRules';
import { AgentPermissionRulesService } from '#/agent/permissionRules/permissionRulesService';
import { IProjectPermissionRulesService } from '#/agent/permissionRules/projectPermissionRules';
import { ProjectPermissionRulesService } from '#/agent/permissionRules/projectPermissionRulesService';
import {
  PERMISSION_SECTION,
  PermissionConfigSchema,
  readUserPermissionRules,
  type PermissionConfig,
} from '#/agent/permissionRules/configSection';
import { permissionRulesKey } from '#/agent/permissionRules/permissionRulesOps';
import { UserConfiguredDenyPermissionPolicyService } from '#/agent/permissionPolicy/policies/user-configured-deny';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

import { stubLog } from '../../_base/log/stubs';
import {
  registerTestAgentWire,
  registerTestEventDispatcher,
  restoreTestEventDispatcher,
  testWireScope,
} from '../../wire/stubs';

const SCOPE = 'wire';
const KEY = 'permission-rules-test';

const allowRule: PermissionRule = { decision: 'allow', scope: 'session-runtime', pattern: 'Read(**)' };
const denyRule: PermissionRule = { decision: 'deny', scope: 'user', pattern: 'Bash(rm *)' };

function sessionApproval(pattern: string): PermissionApprovalResultRecord {
  return {
    turnId: 1,
    toolCallId: 'call-1',
    toolName: 'Bash',
    action: 'Bash(rm -rf /tmp/x)',
    sessionApprovalRule: pattern,
    result: { decision: 'approved', scope: 'session' },
  };
}

class InMemoryConfigStub {
  permission: PermissionConfig | undefined;
  replaceError: Error | undefined;
  readonly replaced: PermissionConfig[] = [];
  private instance: IConfigService | undefined;

  asService(): IConfigService {
    this.instance ??= {
      _serviceBrand: undefined,
      get: <T>(domain: string): T =>
        (domain === PERMISSION_SECTION ? this.permission : undefined) as T,
      assertValid: (domain: string): void => {
        if (domain === PERMISSION_SECTION && this.permission !== undefined) {
          PermissionConfigSchema.parse(this.permission);
        }
      },
      replace: async (domain: string, value: unknown): Promise<void> => {
        await Promise.resolve();
        if (this.replaceError !== undefined) throw this.replaceError;
        if (domain === PERMISSION_SECTION) {
          this.permission = value as PermissionConfig;
          this.replaced.push(this.permission);
        }
      },
    } as unknown as IConfigService;
    return this.instance;
  }
}

interface ProjectRulesStub {
  readonly service: IProjectPermissionRulesService;
  rules: PermissionRule[];
  readonly appended: PermissionRule[];
}

function stubProjectRules(): ProjectRulesStub {
  const stub: ProjectRulesStub = {
    rules: [],
    appended: [],
    service: {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      get rules() {
        return stub.rules;
      },
      appendRules: (rules: readonly PermissionRule[]) => {
        stub.appended.push(...rules);
        stub.rules = [...stub.rules, ...rules];
        return Promise.resolve();
      },
    },
  };
  return stub;
}

let disposables: DisposableStore;
let ix: TestInstantiationService;
let log: IAppendLogStore;
let dispatcher: IEventDispatcher;
let svc: IAgentPermissionRulesService;
let config: InMemoryConfigStub;
let project: ProjectRulesStub;

beforeEach(() => {
  disposables = new DisposableStore();
  ix = disposables.add(new TestInstantiationService());
  ix.stub(IFileSystemStorageService, new InMemoryStorageService());
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  config = new InMemoryConfigStub();
  project = stubProjectRules();
  ix.stub(IConfigService, config.asService());
  ix.stub(IProjectPermissionRulesService, project.service);
  ix.stub(ILogService, stubLog());
  ix.set(IAgentPermissionRulesService, new SyncDescriptor(AgentPermissionRulesService));
  log = ix.get(IAppendLogStore);
  registerTestAgentWire(ix, testWireScope(SCOPE, KEY), { log });
  dispatcher = registerTestEventDispatcher(ix);
  svc = ix.get(IAgentPermissionRulesService);
});

afterEach(() => disposables.dispose());

async function readRecords(): Promise<WireRecord[]> {
  await dispatcher.flush();
  const out: WireRecord[] = [];
  for await (const record of log.read<WireRecord>(testWireScope(SCOPE, KEY), AGENT_WIRE_RECORD_KEY)) {
    out.push(record);
  }
  return out;
}

describe('AgentPermissionRulesService (wire-backed)', () => {
  it('loads startup deny rules and awaits durable writeback without copying it into state', async () => {
    const configRule = { decision: 'deny', scope: 'user', pattern: 'Bash' } as const;
    const projectRule: PermissionRule = { decision: 'allow', scope: 'project', pattern: 'Read(**)' };
    config.permission = { rules: [configRule] };
    project.rules = [projectRule];

    const startup = new AgentPermissionRulesService(
      { dispatch: async () => undefined } as never,
      { agentId: 'startup-agent' } as never,
      new AgentStateService(),
      config.asService(),
      project.service,
    );
    expect(startup.rules).toEqual([projectRule, configRule]);
    expect(new UserConfiguredDenyPermissionPolicyService(startup).evaluate({
      toolCall: { name: 'Bash' },
      execution: {},
    } as never)).toMatchObject({ kind: 'deny' });

    const userRule: PermissionRule = { decision: 'allow', scope: 'user', pattern: 'Write(**)' };
    const otherUserRule: PermissionRule = { decision: 'ask', scope: 'user', pattern: 'Glob(**)' };
    const newProjectRule: PermissionRule = { decision: 'deny', scope: 'project', pattern: 'Bash(rm -rf *)' };
    await svc.addRules([allowRule, userRule, newProjectRule, configRule]);

    expect(svc.rules).toEqual([allowRule, projectRule, newProjectRule, configRule, userRule]);
    expect(ix.get(IAgentStateService).get(permissionRulesKey).rules).toEqual([allowRule]);
    expect(project.appended).toEqual([newProjectRule]);

    const other = new AgentPermissionRulesService(
      { dispatch: async () => undefined } as never,
      { agentId: 'other-agent' } as never,
      new AgentStateService(),
      config.asService(),
      project.service,
    );
    await other.addRules([otherUserRule]);
    await svc.addRules([]);
    expect(config.permission?.rules).toEqual([configRule, userRule, otherUserRule]);

    config.replaceError = new Error('write failed');
    await expect(svc.addRules([
      { decision: 'deny', scope: 'user', pattern: 'Edit(**)' },
    ])).rejects.toThrow('write failed');
    expect(config.permission?.rules).toEqual([configRule, userRule, otherUserRule]);

    const restarted = new AgentPermissionRulesService(
      { dispatch: async () => undefined } as never,
      { agentId: 'restarted-agent' } as never,
      new AgentStateService(),
      config.asService(),
      project.service,
    );
    expect(restarted.rules).toEqual([
      projectRule,
      newProjectRule,
      configRule,
      userRule,
      otherUserRule,
    ]);
  });

  it('records session approval patterns only for session approvals', () => {
    const approval = sessionApproval('Bash(rm *)');
    svc.recordApprovalResult(approval);

    expect(svc.sessionApprovalRulePatterns).toEqual(['Bash(rm *)']);

    svc.recordApprovalResult(approval);
    svc.recordApprovalResult({
      turnId: 2,
      toolCallId: 'call-2',
      toolName: 'Write',
      action: 'Write(/tmp/x)',
      result: { decision: 'approved' },
    });
    expect(svc.sessionApprovalRulePatterns).toEqual(['Bash(rm *)']);
  });

  it('loads local trusted rules, ignores legacy user runtime scopes, and rejects remote project IO', async () => {
    const projectRule: PermissionRule = { decision: 'deny', scope: 'project', pattern: 'Bash' };
    const appendedRule: PermissionRule = { decision: 'allow', scope: 'project', pattern: 'Write' };
    const runtimeRule: PermissionRule = { decision: 'deny', scope: 'session-runtime', pattern: 'Bash' };
    const calls: string[] = [];
    let rawRules: unknown[] = [runtimeRule];
    let trusted = false;
    let failAppend = false;
    const localConfig = {
      readPermissionRules: async (cwd: string) => {
        calls.push(cwd);
        return { projectRoot: cwd, configPath: `${cwd}/.kimi-code/local.toml`, rules: rawRules };
      },
      appendPermissionRules: async (cwd: string, rules: readonly unknown[]) => {
        calls.push(cwd);
        if (failAppend) throw new Error('append failed');
        rawRules = [...rawRules, ...rules];
        return { projectRoot: cwd, configPath: `${cwd}/.kimi-code/local.toml`, rules: rawRules };
      },
    } as never;
    const trust = { get: async () => trusted } as never;
    const untrusted = new ProjectPermissionRulesService(
      { cwd: '/local-association' } as never,
      { environmentId: 'local', cwd: '/local/project' } as never,
      localConfig,
      trust,
    );
    await untrusted.ready;
    expect(untrusted.rules).toEqual([]);
    expect(calls).toEqual([]);

    trusted = true;
    rawRules = [projectRule];
    const local = new ProjectPermissionRulesService(
      { cwd: '/local-association' } as never,
      { environmentId: 'local', cwd: '/local/project' } as never,
      localConfig,
      trust,
    );
    await local.ready;
    expect(local.rules).toEqual([projectRule]);

    rawRules = [projectRule, appendedRule];
    expect(local.rules).toEqual([projectRule]);
    rawRules = [projectRule];
    failAppend = true;
    await expect(local.appendRules([appendedRule])).rejects.toThrow('append failed');
    expect(local.rules).toEqual([projectRule]);

    failAppend = false;
    await local.appendRules([appendedRule]);
    expect(local.rules).toEqual([projectRule, appendedRule]);

    rawRules = [runtimeRule];
    const invalid = new ProjectPermissionRulesService(
      { cwd: '/local-association' } as never,
      { environmentId: 'local', cwd: '/local/project' } as never,
      localConfig,
      trust,
    );
    await expect(invalid.ready).rejects.toThrow('Invalid project permission rule');

    const remote = new ProjectPermissionRulesService(
      { cwd: '/local-association' } as never,
      { environmentId: 'ssh', cwd: '/remote/project' } as never,
      localConfig,
      { get: async () => { throw new Error('remote trust must not be read'); } } as never,
    );
    await remote.ready;
    expect(remote.rules).toEqual([]);
    await expect(remote.appendRules([appendedRule])).rejects.toThrow('not supported');
    expect(calls).toEqual([
      '/local/project',
      '/local/project',
      '/local/project',
      '/local/project',
    ]);

    const userRule: PermissionRule = { ...runtimeRule, scope: 'user' };
    config.permission = {
      rules: [runtimeRule, { ...runtimeRule, scope: 'turn-override' }, userRule],
    };
    expect(readUserPermissionRules(config.asService())).toEqual([userRule]);
    config.permission = {
      rules: [{ ...runtimeRule, scope: 'invalid' }],
    } as unknown as PermissionConfig;
    expect(() => readUserPermissionRules(config.asService())).toThrow();
  });

  it('only persists approval records (permission.rules.add is live-only)', async () => {
    await svc.addRules([allowRule]);
    svc.recordApprovalResult(sessionApproval('Bash(rm *)'));

    const records = await readRecords();
    expect(records).toEqual([
      {
        type: 'permission.record_approval_result',
        agentId: 'test-agent',
        turnId: 1,
        toolCallId: 'call-1',
        toolName: 'Bash',
        action: 'Bash(rm -rf /tmp/x)',
        sessionApprovalRule: 'Bash(rm *)',
        result: { decision: 'approved', scope: 'session' },
        time: expect.any(Number),
      },
    ]);
    expect(records.every((record) => 'payload' in record === false)).toBe(true);
    expect(config.replaced).toEqual([]);
    expect(project.appended).toEqual([]);
  });

  it('replay rebuilds session approval patterns only (rules are not persisted)', async () => {
    await svc.addRules([allowRule, denyRule]);
    svc.recordApprovalResult(sessionApproval('Bash(rm *)'));
    const records = await readRecords();

    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    const log2 = ix2.get(IAppendLogStore);
    registerTestAgentWire(ix2, testWireScope(SCOPE, 'permission-rules-replay'), {
      log: log2,
    });
    const fresh = registerTestEventDispatcher(ix2);
    const freshState = ix2.get(IAgentStateService);
    freshState.contributeState(permissionRulesKey);

    await restoreTestEventDispatcher(
      fresh,
      log2,
      testWireScope(SCOPE, 'permission-rules-replay'),
      records,
    );

    expect(freshState.get(permissionRulesKey)).toEqual({
      rules: [],
      sessionApprovalRulePatterns: ['Bash(rm *)'],
    });
    const written: WireRecord[] = [];
    for await (const record of log2.read<WireRecord>(testWireScope(SCOPE, 'permission-rules-replay'), AGENT_WIRE_RECORD_KEY)) {
      written.push(record);
    }
    expect(written[0]).toMatchObject({ type: 'metadata' });
    expect(written.slice(1)).toEqual(records);
  });
});
