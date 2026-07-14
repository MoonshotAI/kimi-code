import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentPermissionRulesService, type PermissionApprovalResultRecord, type PermissionRule } from '#/agent/permissionRules/permissionRules';
import { AgentPermissionRulesService } from '#/agent/permissionRules/permissionRulesService';
import { PermissionRulesModel } from '#/agent/permissionRules/permissionRulesOps';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IWireService } from '#/wire/wire';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

import { registerTestAgentWire, restoreTestAgentWire, testWireScope } from '../../wire/stubs';

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

let disposables: DisposableStore;
let ix: TestInstantiationService;
let log: IAppendLogStore;
let svc: IAgentPermissionRulesService;

beforeEach(() => {
  disposables = new DisposableStore();
  ix = disposables.add(new TestInstantiationService());
  ix.stub(IFileSystemStorageService, new InMemoryStorageService());
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  ix.set(IAgentPermissionRulesService, new SyncDescriptor(AgentPermissionRulesService));
  log = ix.get(IAppendLogStore);
  registerTestAgentWire(ix, testWireScope(SCOPE, KEY), { log });
  svc = ix.get(IAgentPermissionRulesService);
});

afterEach(() => disposables.dispose());

async function readRecords(): Promise<WireRecord[]> {
  await ix.get(IWireService).flush();
  const out: WireRecord[] = [];
  for await (const record of log.read<WireRecord>(testWireScope(SCOPE, KEY), AGENT_WIRE_RECORD_KEY)) {
    out.push(record);
  }
  return out;
}

describe('AgentPermissionRulesService (wire-backed)', () => {
  it('addRules appends rules and exposes the accumulated rules', () => {
    expect(svc.rules).toEqual([]);

    svc.addRules([allowRule]);
    expect(svc.rules).toEqual([allowRule]);
    svc.addRules([denyRule]);
    expect(svc.rules).toEqual([allowRule, denyRule]);

    svc.addRules([]);
    expect(svc.rules).toEqual([allowRule, denyRule]);
  });

  it('records a session approval pattern', () => {
    const approval = sessionApproval('Bash(rm *)');
    svc.recordApprovalResult(approval);

    expect(svc.sessionApprovalRulePatterns).toEqual(['Bash(rm *)']);

    svc.recordApprovalResult(approval);
    expect(svc.sessionApprovalRulePatterns).toEqual(['Bash(rm *)']);
  });

  it('ignores non-session approvals for the pattern set', () => {
    const oneTime: PermissionApprovalResultRecord = {
      turnId: 2,
      toolCallId: 'call-2',
      toolName: 'Write',
      action: 'Write(/tmp/x)',
      result: { decision: 'approved' },
    };
    svc.recordApprovalResult(oneTime);
    expect(svc.sessionApprovalRulePatterns).toEqual([]);
  });

  it('only persists approval records (permission.rules.add is live-only)', async () => {
    svc.addRules([allowRule]);
    svc.recordApprovalResult(sessionApproval('Bash(rm *)'));

    const records = await readRecords();
    expect(records).toEqual([
      {
        type: 'permission.record_approval_result',
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
  });

  it('replay rebuilds session approval patterns only (rules are not persisted)', async () => {
    svc.addRules([allowRule, denyRule]);
    svc.recordApprovalResult(sessionApproval('Bash(rm *)'));
    const records = await readRecords();

    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    const log2 = ix2.get(IAppendLogStore);
    const fresh = registerTestAgentWire(ix2, testWireScope(SCOPE, 'permission-rules-replay'), {
      log: log2,
    });

    await restoreTestAgentWire(
      fresh,
      log2,
      testWireScope(SCOPE, 'permission-rules-replay'),
      records,
    );

    expect(fresh.getModel(PermissionRulesModel)).toEqual({
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
