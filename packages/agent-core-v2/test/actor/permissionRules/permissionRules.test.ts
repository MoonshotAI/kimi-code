import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AgentPermissionRules,
  type PermissionRulesRuntime,
} from '#/actor/permissionRules/permissionRulesAgentRuntime';
import type {
  PermissionApprovalResultRecord,
  PermissionRule,
} from '#/actor/permissionRules/types';
import { matchesGlobRuleSubject } from '#/tool/rule-match';
import { IWireService } from '#/wire/wire';

import {
  createTestAgent,
  InMemoryWireRecordPersistence,
  type TestAgentContext,
} from '../../harness';

const allowRule: PermissionRule = { decision: 'allow', scope: 'user', pattern: 'Read(**)' };
const denyRule: PermissionRule = { decision: 'deny', scope: 'user', pattern: 'Bash(rm *)' };
const configRule: PermissionRule = { decision: 'allow', scope: 'user', pattern: 'Glob' };

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

function bashRequest(command: string) {
  return {
    toolName: 'Bash',
    input: { command },
    execution: {
      matchesRule: (ruleArgs: string) => matchesGlobRuleSubject(ruleArgs, command),
    },
  } as const;
}

function permissionRecords(persistence: InMemoryWireRecordPersistence) {
  return persistence.records.filter((record) => record.type.startsWith('permission.'));
}

describe('Agent permissionRules (AgentPermissionRules)', () => {
  let ctx: TestAgentContext;
  let permissionRules: PermissionRulesRuntime;

  beforeEach(() => {
    ctx = createTestAgent();
    permissionRules = ctx.resolve(AgentPermissionRules);
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('starts empty and accumulates added rules', async () => {
    expect(permissionRules.rules()).toEqual([]);

    await permissionRules.addRules([allowRule]);
    expect(permissionRules.rules()).toEqual([allowRule]);
    await permissionRules.addRules([denyRule]);
    expect(permissionRules.rules()).toEqual([allowRule, denyRule]);

    await permissionRules.addRules([]);
    expect(permissionRules.rules()).toEqual([allowRule, denyRule]);
  });

  it('records a session approval pattern once', async () => {
    const approval = sessionApproval('Bash(rm *)');
    await permissionRules.recordApproval(approval);

    expect(permissionRules.approvalPatterns()).toEqual([{ pattern: 'Bash(rm *)' }]);

    await permissionRules.recordApproval(approval);
    expect(permissionRules.approvalPatterns()).toEqual([{ pattern: 'Bash(rm *)' }]);
  });

  it('ignores non-session approvals for the pattern set', async () => {
    await permissionRules.recordApproval({
      turnId: 2,
      toolCallId: 'call-2',
      toolName: 'Write',
      action: 'Write(/tmp/x)',
      result: { decision: 'approved' },
    });
    await permissionRules.recordApproval({
      turnId: 3,
      toolCallId: 'call-3',
      toolName: 'Write',
      action: 'Write(/tmp/y)',
      sessionApprovalRule: 'Write(/tmp/**)',
      result: { decision: 'rejected' },
    });

    expect(permissionRules.approvalPatterns()).toEqual([]);
  });

  it('evaluates deny rules ahead of approval patterns and ask or allow rules', async () => {
    await permissionRules.addRules([
      { decision: 'allow', scope: 'project', pattern: 'Bash' },
      { decision: 'ask', scope: 'user', pattern: 'Bash' },
      denyRule,
    ]);
    await permissionRules.recordApproval(sessionApproval('Bash(rm *)'));

    expect(permissionRules.evaluate(bashRequest('rm -rf x'))).toBe('deny');
  });

  it('reuses approve-for-session ahead of matching ask and allow rules', async () => {
    await permissionRules.addRules([
      { decision: 'allow', scope: 'project', pattern: 'Bash' },
      { decision: 'ask', scope: 'user', pattern: 'Bash' },
    ]);
    await permissionRules.recordApproval(sessionApproval('Bash(git *)'));

    expect(permissionRules.evaluate(bashRequest('git status'))).toBe('allow');
    expect(permissionRules.evaluateApproval(bashRequest('git status'))).toMatchObject({
      strategy: 'matches_rule',
      hasRuleArgs: true,
    });
    expect(permissionRules.evaluate(bashRequest('npm test'))).toBe('ask');
  });

  it('keeps ask rules ahead of matching allow rules', async () => {
    await permissionRules.addRules([
      { decision: 'allow', scope: 'project', pattern: 'Bash' },
      { decision: 'ask', scope: 'user', pattern: 'Bash' },
    ]);

    expect(permissionRules.evaluate(bashRequest('printf first'))).toBe('ask');
    expect(permissionRules.evaluateRule(bashRequest('printf first'), 'ask')).toMatchObject({
      rule: { decision: 'ask', scope: 'user', pattern: 'Bash' },
      strategy: 'tool_name_only',
      hasRuleArgs: false,
    });
  });

  it('returns allow for a matching allow rule and ask when nothing matches', async () => {
    await permissionRules.addRules([{ decision: 'allow', scope: 'user', pattern: 'Bash' }]);

    expect(permissionRules.evaluate(bashRequest('printf first'))).toBe('allow');
    expect(permissionRules.evaluate({ toolName: 'Write', input: {}, execution: {} })).toBe('ask');
  });

  it('does not evaluate session-runtime scoped rules as user-configured rules', async () => {
    await permissionRules.addRules([
      { decision: 'allow', scope: 'session-runtime', pattern: 'Bash' },
    ]);

    expect(permissionRules.evaluateRule(bashRequest('printf first'), 'allow')).toBeUndefined();
    expect(permissionRules.evaluate(bashRequest('printf first'))).toBe('ask');
  });

  it('matches rule arguments through the execution matcher', async () => {
    await permissionRules.addRules([
      { decision: 'deny', scope: 'user', pattern: 'Bash(git *)', reason: 'no git' },
    ]);

    const denied = permissionRules.evaluateRule(bashRequest('git status'), 'deny');
    expect(denied).toMatchObject({
      strategy: 'matches_rule',
      hasRuleArgs: true,
      rule: { decision: 'deny', scope: 'user', pattern: 'Bash(git *)', reason: 'no git' },
    });
    expect(permissionRules.evaluate(bashRequest('npm test'))).toBe('ask');
    expect(
      permissionRules.evaluateRule({ toolName: 'Bash', input: {}, execution: {} }, 'deny'),
    ).toBeUndefined();
  });

  it('persists only approval records (permission.rules.add is live-only)', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const live = createTestAgent({ persistence });
    try {
      const liveRules = live.resolve(AgentPermissionRules);
      await liveRules.addRules([allowRule]);
      await liveRules.recordApproval(sessionApproval('Bash(rm *)'));
      await live.get(IWireService).flush();

      expect(permissionRecords(persistence)).toEqual([
        {
          type: 'permission.record_approval_result',
          agentId: 'main',
          turnId: 1,
          toolCallId: 'call-1',
          toolName: 'Bash',
          action: 'Bash(rm -rf /tmp/x)',
          sessionApprovalRule: 'Bash(rm *)',
          result: { decision: 'approved', scope: 'session' },
          time: expect.any(Number),
        },
      ]);
      expect(permissionRecords(persistence).every((record) => !('payload' in record))).toBe(true);
    } finally {
      await live.dispose();
    }
  });

  it('replay rebuilds approval patterns only and appends nothing', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const live = createTestAgent({ persistence });
    try {
      const liveRules = live.resolve(AgentPermissionRules);
      await liveRules.addRules([allowRule, denyRule]);
      await liveRules.recordApproval(sessionApproval('Bash(rm *)'));
      await live.get(IWireService).flush();
    } finally {
      await live.dispose();
    }
    const written = permissionRecords(persistence);

    const resumed = createTestAgent({ persistence, autoConfigure: false });
    try {
      await resumed.restorePersisted();
      const resumedRules = resumed.resolve(AgentPermissionRules);

      expect(resumedRules.rules()).toEqual([]);
      expect(resumedRules.approvalPatterns()).toEqual([{ pattern: 'Bash(rm *)' }]);
      expect(permissionRecords(persistence)).toEqual(written);
    } finally {
      await resumed.dispose();
    }
  });

  it('replays a pre-migration approval record journal', async () => {
    const persistence = new InMemoryWireRecordPersistence([
      {
        type: 'permission.record_approval_result',
        agentId: 'main',
        turnId: 1,
        toolCallId: 'call-1',
        toolName: 'Bash',
        action: 'Bash(rm -rf /tmp/x)',
        sessionApprovalRule: 'Bash(rm *)',
        result: { decision: 'approved', scope: 'session' },
        time: 1750000000000,
      },
    ]);
    const replayed = createTestAgent({ persistence, autoConfigure: false });
    try {
      await replayed.restorePersisted();

      expect(replayed.resolve(AgentPermissionRules).approvalPatterns()).toEqual([
        { pattern: 'Bash(rm *)' },
      ]);
    } finally {
      await replayed.dispose();
    }
  });
});

describe('Agent permissionRules config seeding', () => {
  it('seeds [permission] config rules ahead of added rules and evaluates them', async () => {
    const ctx = createTestAgent({
      initialConfig: { permission: { rules: [configRule, denyRule] } },
    });
    try {
      const permissionRules = ctx.resolve(AgentPermissionRules);

      expect(permissionRules.rules()).toEqual([configRule, denyRule]);

      await permissionRules.addRules([allowRule]);
      expect(permissionRules.rules()).toEqual([configRule, denyRule, allowRule]);

      expect(permissionRules.evaluate(bashRequest('rm -rf x'))).toBe('deny');
      expect(permissionRules.evaluate({ toolName: 'Glob', input: {}, execution: {} })).toBe(
        'allow',
      );
    } finally {
      await ctx.dispose();
    }
  });

  it('re-seeds config rules after a restore', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const live = createTestAgent({
      persistence,
      initialConfig: { permission: { rules: [configRule] } },
    });
    try {
      await live.get(IWireService).flush();
    } finally {
      await live.dispose();
    }

    const resumed = createTestAgent({
      persistence,
      autoConfigure: false,
      initialConfig: { permission: { rules: [configRule] } },
    });
    try {
      await resumed.restorePersisted();

      expect(resumed.resolve(AgentPermissionRules).rules()).toEqual([configRule]);
    } finally {
      await resumed.dispose();
    }
  });
});
