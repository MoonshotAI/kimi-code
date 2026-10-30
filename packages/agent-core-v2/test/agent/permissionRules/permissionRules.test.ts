import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ToolCall } from '#human/llm/message';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentPermissionPolicyService } from '#/agent/permissionPolicy/permissionPolicy';
import { IAgentConversationUndoParticipantRegistry } from '#/agent/contextMemory/conversationUndoParticipants';
import { IAgentPermissionRulesService, type PermissionApprovalResultRecord, type PermissionRule } from '#/agent/permissionRules/permissionRules';
import { AgentPermissionRulesService } from '#/agent/permissionRules/permissionRulesService';
import { permissionRulesKey } from '#/agent/permissionRules/permissionRulesOps';
import { IAgentStateService } from '#/agent/state/agentState';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

import { createTestAgent } from '../../harness';
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

let disposables: DisposableStore;
let ix: TestInstantiationService;
let log: IAppendLogStore;
let dispatcher: IEventDispatcher;
let svc: IAgentPermissionRulesService;

beforeEach(() => {
  disposables = new DisposableStore();
  ix = disposables.add(new TestInstantiationService());
  ix.stub(IFileSystemStorageService, new InMemoryStorageService());
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
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

function toolContext(toolName: string): ResolvedToolExecutionHookContext {
  const toolCall: ToolCall = {
    type: 'function',
    id: `call-${toolName}`,
    name: toolName,
    arguments: '{}',
  };
  return {
    turnId: 1,
    signal: new AbortController().signal,
    toolCall,
    toolCalls: [toolCall],
    args: {},
    execution: {
      description: `Call ${toolName}`,
      approvalRule: toolName,
      execute: () => Promise.resolve({ output: '' }),
    },
  };
}

describe('PermissionRulesConfigBridge', () => {
  it('loads permission rules from the permission config section', async () => {
    const rule: PermissionRule = { decision: 'deny', scope: 'user', pattern: 'Bash' };
    const ctx = createTestAgent({ initialConfig: { permission: { rules: [rule] } } });
    try {
      expect(ctx.get(IAgentPermissionRulesService).rules).toEqual([rule]);
    } finally {
      await ctx.dispose();
    }
  });

  it('lets configured deny rules win over auto-mode approval', async () => {
    const rule: PermissionRule = { decision: 'deny', scope: 'user', pattern: 'Bash' };
    const ctx = createTestAgent({ initialConfig: { permission: { rules: [rule] } } });
    try {
      ctx.get(IAgentPermissionModeService).setMode('auto');
      const evaluation = await ctx
        .get(IAgentPermissionPolicyService)
        .evaluate(toolContext('Bash'));

      expect(evaluation).toEqual({
        policyName: 'user-configured-deny',
        result: { kind: 'deny', message: 'Tool "Bash" was denied by permission rule.' },
      });
    } finally {
      await ctx.dispose();
    }
  });

  it('leaves the rules empty when the section is absent', async () => {
    const ctx = createTestAgent();
    try {
      expect(ctx.get(IAgentPermissionRulesService).rules).toEqual([]);
    } finally {
      await ctx.dispose();
    }
  });

  it('enforces configured rules with the session-runtime scope', async () => {
    const rule: PermissionRule = {
      decision: 'deny',
      scope: 'session-runtime',
      pattern: 'Bash',
    };
    const ctx = createTestAgent({ initialConfig: { permission: { rules: [rule] } } });
    try {
      ctx.get(IAgentPermissionModeService).setMode('auto');
      const evaluation = await ctx
        .get(IAgentPermissionPolicyService)
        .evaluate(toolContext('Bash'));

      expect(evaluation?.policyName).toBe('user-configured-deny');
    } finally {
      await ctx.dispose();
    }
  });

  it('reseeds configured rules after an undo replay resets them', async () => {
    const rule: PermissionRule = { decision: 'deny', scope: 'user', pattern: 'Bash' };
    const ctx = createTestAgent({ initialConfig: { permission: { rules: [rule] } } });
    try {
      await ctx.restorePersisted();
      await ctx.dispatcher.restore();
      expect(ctx.get(IAgentPermissionRulesService).rules).toEqual([]);

      const participant = ctx
        .get(IAgentConversationUndoParticipantRegistry)
        .list()
        .find((entry) => entry.id === 'permissionRules.config');
      expect(participant).toBeDefined();
      await participant!.reconcileAfterUndo();
      await ctx.dispatcher.flush();

      expect(ctx.get(IAgentPermissionRulesService).rules).toEqual([rule]);
    } finally {
      await ctx.dispose();
    }
  });
});
