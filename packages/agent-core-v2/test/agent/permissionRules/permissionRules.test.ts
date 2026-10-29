import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IConfigService } from '#/app/config/config';
import { IAgentPermissionRulesService, type PermissionApprovalResultRecord, type PermissionRule } from '#/agent/permissionRules/permissionRules';
import { AgentPermissionRulesService } from '#/agent/permissionRules/permissionRulesService';
import { IProjectPermissionRulesService } from '#/agent/permissionRules/projectPermissionRules';
import { ProjectPermissionRulesService } from '#/agent/permissionRules/projectPermissionRulesService';
import { PERMISSION_SECTION, type PermissionConfig } from '#/agent/permissionRules/configSection';
import { permissionRulesKey } from '#/agent/permissionRules/permissionRulesOps';
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
  readonly replaced: PermissionConfig[] = [];
  private instance: IConfigService | undefined;

  asService(): IConfigService {
    this.instance ??= {
      _serviceBrand: undefined,
      get: <T>(domain: string): T =>
        (domain === PERMISSION_SECTION ? this.permission : undefined) as T,
      replace: async (domain: string, value: unknown): Promise<void> => {
        await Promise.resolve();
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
  it('merges state, project, and config rules and persists durable scopes', async () => {
    const configRule: PermissionRule = { decision: 'deny', scope: 'user', pattern: 'Bash(git push *)' };
    const projectRule: PermissionRule = { decision: 'allow', scope: 'project', pattern: 'Read(**)' };
    config.permission = { rules: [configRule] };
    project.rules = [projectRule];

    expect(svc.rules).toEqual([projectRule, configRule]);

    const userRule: PermissionRule = { decision: 'allow', scope: 'user', pattern: 'Write(**)' };
    const otherUserRule: PermissionRule = { decision: 'ask', scope: 'user', pattern: 'Glob(**)' };
    const newProjectRule: PermissionRule = { decision: 'deny', scope: 'project', pattern: 'Bash(rm -rf *)' };
    const other = new AgentPermissionRulesService(
      { dispatch: async () => undefined } as never,
      { agentId: 'other-agent' } as never,
      new AgentStateService(),
      config.asService(),
      project.service,
      stubLog(),
    );
    svc.addRules([allowRule, userRule, newProjectRule, configRule]);

    expect(svc.rules).toEqual([allowRule, userRule, newProjectRule, configRule, projectRule]);

    other.addRules([otherUserRule]);
    await vi.waitFor(() => {
      expect(config.permission?.rules).toEqual([configRule, userRule, otherUserRule]);
      expect(project.appended).toEqual([newProjectRule]);
    });

    svc.addRules([]);
    expect(svc.rules).toEqual([allowRule, userRule, newProjectRule, configRule, projectRule, otherUserRule]);
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

  it('uses the actual session workdir for project rule IO', async () => {
    const remoteRule: PermissionRule = { decision: 'deny', scope: 'project', pattern: 'Bash' };
    const calls: string[] = [];
    const localConfig = {
      readPermissionRules: async (cwd: string) => {
        calls.push(cwd);
        return { projectRoot: cwd, configPath: `${cwd}/.kimi-code/local.toml`, rules: [remoteRule] };
      },
      appendPermissionRules: async (cwd: string, rules: readonly unknown[]) => {
        calls.push(cwd);
        return { projectRoot: cwd, configPath: `${cwd}/.kimi-code/local.toml`, rules };
      },
    } as never;
    const remote = new ProjectPermissionRulesService(
      { cwd: '/local-association' } as never,
      { environmentId: 'ssh', cwd: '/remote/project' } as never,
      localConfig,
      stubLog(),
    );

    await remote.ready;
    expect(remote.rules).toEqual([remoteRule]);
    await remote.appendRules([remoteRule]);
    expect(calls).toEqual(['/remote/project', '/remote/project']);
    remote.dispose();
  });

  it('only persists approval records (permission.rules.add is live-only)', async () => {
    svc.addRules([allowRule]);
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
    svc.addRules([allowRule, denyRule]);
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
