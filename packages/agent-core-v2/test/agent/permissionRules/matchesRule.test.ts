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

  it('matches glob rule subjects as opaque text rather than as paths', () => {
    expect(matchesGlobRuleSubject('rm -rf*', 'rm -rf x')).toBe(true);
    expect(matchesGlobRuleSubject('rm -rf*', 'rm -rf /tmp/x')).toBe(true);
    expect(matchesGlobRuleSubject('git *', 'git commit -m "fix src/a.ts"')).toBe(true);
    expect(matchesGlobRuleSubject('rm -rf*', 'rm -rf ./build')).toBe(true);
    expect(matchesGlobRuleSubject('rm -rf*', 'rm -rf ~/.ssh')).toBe(true);
    expect(matchesGlobRuleSubject('rm -rf*', 'rm -rf /home/u/.ssh')).toBe(true);
    expect(matchesGlobRuleSubject('https://example.com/*', 'https://example.com/a/b')).toBe(true);
    expect(matchesGlobRuleSubject('*acme corp*', 'news about acme corp / rivals')).toBe(true);
    expect(matchesGlobRuleSubject('**rm**', 'rm -rf /tmp/x')).toBe(true);
    expect(matchesGlobRuleSubject('git *', 'git status')).toBe(true);
    expect(matchesGlobRuleSubject('git *', 'git2 status')).toBe(false);
    expect(matchesGlobRuleSubject('rm -rf*', 'git status')).toBe(false);
    expect(matchesGlobRuleSubject('git log -- src/*.ts', 'git log -- srcXx.ts')).toBe(false);
    expect(matchesGlobRuleSubject('https://example.com/a', 'https://example.com/b')).toBe(false);
    expect(matchesGlobRuleSubject('!git *', 'git commit -m "fix src/a.ts"')).toBe(false);
    expect(matchesGlobRuleSubject('!git *', 'npm test')).toBe(true);
  });

  it('keeps historical glob matches that opaque-text semantics alone would drop', () => {
    expect(matchesGlobRuleSubject('**/*.ts', 'a.ts')).toBe(true);
    expect(matchesGlobRuleSubject('a/**/b', 'a/b')).toBe(true);
    expect(matchesGlobRuleSubject('a/**/b', 'a/x/y/b')).toBe(true);
    expect(matchesGlobRuleSubject('a/b', 'a\u0000b')).toBe(false);
  });

  it('keeps path rule subjects on path semantics where * does not cross /', () => {
    expect(matchesPathRuleSubject('src/*', 'src/a.ts')).toBe(true);
    expect(matchesPathRuleSubject('src/**', 'src/sub/a.ts')).toBe(true);
    expect(matchesPathRuleSubject('src/*', 'src/sub/a.ts')).toBe(false);
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
