import { describe, expect, it } from 'vitest';

import type { PermissionRule } from '#/agent/permissionRules/permissionRules';
import {
  matchPermissionRule,
  parsePattern,
} from '#/agent/permissionRules/matchesRule';
import type { PermissionRuleMatchExecution } from '#/agent/permissionRules/matchesRule';
import {
  matchesGlobRuleSubject,
  matchesPathRuleSubject,
} from '#/tool/rule-match';

function rule(pattern: string): PermissionRule {
  return { decision: 'allow', scope: 'user', pattern };
}

const noArgs: PermissionRuleMatchExecution = {};
const matchAll: PermissionRuleMatchExecution = {
  matchesRule: () => true,
};
const matchNone: PermissionRuleMatchExecution = {
  matchesRule: () => false,
};

describe('permissionRules/parsePattern', () => {
  it('parses a bare tool name', () => {
    expect(parsePattern('bash')).toEqual({ toolName: 'bash' });
  });

  it('trims whitespace', () => {
    expect(parsePattern('  read  ')).toEqual({ toolName: 'read' });
  });

  it('parses tool(args)', () => {
    expect(parsePattern('bash(src/**)')).toEqual({
      toolName: 'bash',
      argPattern: 'src/**',
    });
  });

  it('treats empty parens as tool-name-only', () => {
    expect(parsePattern('bash()')).toEqual({ toolName: 'bash' });
  });

  it('throws on empty string', () => {
    expect(() => parsePattern('')).toThrow(/empty/);
  });

  it('throws on missing closing paren', () => {
    expect(() => parsePattern('bash(src')).toThrow(/missing closing paren/);
  });

  it('throws on empty tool name', () => {
    expect(() => parsePattern('(src)')).toThrow(/empty tool name/);
  });
});

describe('permissionRules/matchPermissionRule', () => {
  it('matches by tool name only when pattern has no args', () => {
    expect(matchPermissionRule({ rule: rule('bash'), toolName: 'bash', execution: noArgs }))
      .toMatchObject({ strategy: 'tool_name_only', hasRuleArgs: false });
  });

  it('returns undefined when tool name does not match', () => {
    expect(
      matchPermissionRule({ rule: rule('bash'), toolName: 'read', execution: noArgs }),
    ).toBeUndefined();
  });

  it('supports glob tool patterns', () => {
    expect(
      matchPermissionRule({ rule: rule('mcp__*'), toolName: 'mcp__search', execution: noArgs }),
    ).toMatchObject({ strategy: 'tool_name_only' });
  });

  it('delegates arg matching to execution.matchesRule', () => {
    expect(
      matchPermissionRule({
        rule: rule('bash(src/**)'),
        toolName: 'bash',
        execution: matchAll,
      }),
    ).toMatchObject({ strategy: 'matches_rule', hasRuleArgs: true });

    expect(
      matchPermissionRule({
        rule: rule('bash(src/**)'),
        toolName: 'bash',
        execution: matchNone,
      }),
    ).toBeUndefined();
  });

  it('returns undefined for an unparseable rule pattern', () => {
    expect(
      matchPermissionRule({ rule: rule('('), toolName: 'bash', execution: noArgs }),
    ).toBeUndefined();
  });

  it('matches rules against tool-specific argument fields through execution matchers', () => {
    expect(matches(rule('Bash(git *)'), 'Bash', {
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, 'git status'),
    })).toBe(true);
    expect(matches(rule('Bash(git *)'), 'Bash', {
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, 'npm test'),
    })).toBe(false);
    expect(matches(rule('Read(/etc/**)'), 'Read', {
      matchesRule: (ruleArgs) => matchesPathRuleSubject(ruleArgs, '/etc/passwd'),
    })).toBe(true);
    expect(matches(rule('Edit(!./src/**)'), 'Edit', {
      matchesRule: (ruleArgs) =>
        matchesPathRuleSubject(ruleArgs, '/workspace/README.md', {
          cwd: '/workspace',
          pathClass: 'posix',
        }),
    })).toBe(true);
    expect(matches(rule('Edit(!./src/**)'), 'Edit', {
      matchesRule: (ruleArgs) =>
        matchesPathRuleSubject(ruleArgs, '/workspace/src/a.ts', {
          cwd: '/workspace',
          pathClass: 'posix',
        }),
    })).toBe(false);
    expect(matches(rule('Agent(review-*)'), 'Agent', {
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, 'review-code'),
    })).toBe(true);
    expect(matches(rule('mcp__github__*'), 'mcp__github__list_issues', noArgs)).toBe(true);
    expect(matches(rule('Bash(git *)'), 'Bash', {
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, '42'),
    })).toBe(false);
    expect(matches(rule('Bad(unclosed'), 'Bad', noArgs)).toBe(false);
  });

  it('does not match rule arguments without an execution matcher', () => {
    expect(matches(rule('Custom("query":"a.b")'), 'Custom', noArgs)).toBe(false);
    expect(matches(rule('Bash("command":"git status")'), 'Bash', noArgs)).toBe(false);
    expect(matches(rule('Bash(^git status$)'), 'Bash', noArgs)).toBe(false);
    expect(matches(rule('Read([invalid'), 'Read', noArgs)).toBe(false);
    expect(matches(rule('AgentSwarm(swarm)'), 'AgentSwarm', noArgs)).toBe(false);
  });

  it('matches path rule subjects case-insensitively', () => {
    expect(matches(rule('Edit(/repo/secrets.env)'), 'Edit', {
      matchesRule: (ruleArgs) =>
        matchesPathRuleSubject(ruleArgs, '/repo/Secrets.env', {
          cwd: '/repo',
          pathClass: 'posix',
        }),
    })).toBe(true);
    expect(matches(rule('Edit(/repo/Sub/**)'), 'Edit', {
      matchesRule: (ruleArgs) =>
        matchesPathRuleSubject(ruleArgs, '/repo/sub/a.ts', {
          cwd: '/repo',
          pathClass: 'posix',
        }),
    })).toBe(true);
  });
});

function matches(
  permissionRule: PermissionRule,
  toolName: string,
  execution: PermissionRuleMatchExecution,
): boolean {
  return matchPermissionRule({ rule: permissionRule, toolName, execution }) !== undefined;
}
