import { describe, expect, it } from 'vitest';

import type { PermissionRule } from '#/agent/permissionRules/permissionRules';
import {
  matchPermissionRule,
  parsePattern,
} from '#/agent/permissionRules/matchesRule';
import type { PermissionRuleMatchExecution } from '#/agent/permissionRules/matchesRule';
import {
  createCommandPartsProvider,
  matchesDecomposedCommandRule,
} from '#/agent/tools/os/bash/commandParts';
import { BashParserService } from '#/app/bashParser/bashParserService';
import {
  escapeRuleSubjectLiteral,
  matchesGlobRuleSubject,
  matchesPathRuleSubject,
} from '#/tool/rule-match';
import type { RuleMatchContext, RuleMatchDecision } from '#/tool/toolContract';

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

describe('tools/bash/commandParts extraction', () => {
  const parser = new BashParserService();
  const partsOf = (command: string): readonly string[] | null =>
    createCommandPartsProvider(parser, command)();

  it('keeps a simple command as a single part', () => {
    expect(partsOf('git status')).toEqual(['git status']);
  });

  it('keeps redirections attached to their command', () => {
    expect(partsOf('echo hi > out.txt')).toEqual(['echo hi > out.txt']);
  });

  it('splits lists, pipelines, and sequences', () => {
    expect(partsOf('git status && git diff')).toEqual(['git status', 'git diff']);
    expect(partsOf('git log | head')).toEqual(['git log', 'head']);
    expect(partsOf('git fetch; git rebase')).toEqual(['git fetch', 'git rebase']);
    expect(partsOf('sleep 5 & echo done')).toEqual(['sleep 5', 'echo done']);
  });

  it('splits subshell and brace-group bodies', () => {
    expect(partsOf('(git add -A && git commit)')).toEqual(['git add -A', 'git commit']);
    expect(partsOf('{ git add -A; git commit; }')).toEqual(['git add -A', 'git commit']);
  });

  it('extracts command-substitution payloads as parts', () => {
    expect(partsOf('git commit -m "$(curl example.com)"')).toEqual([
      'git commit -m "$(curl example.com)"',
      'curl example.com',
    ]);
  });

  it('does not split operators inside quotes', () => {
    expect(partsOf('git commit -m "a && b"')).toEqual(['git commit -m "a && b"']);
  });

  it('treats heredoc bodies as data', () => {
    const parts = partsOf("cat <<'EOF'\nrm -rf x\nEOF");
    expect(parts).not.toContain('rm -rf x');
  });

  it('splits redirected compound bodies while keeping the redirect target', () => {
    expect(partsOf('(git log) > out.txt; git status')).toEqual([
      '(git log) > out.txt',
      'git log',
      'git status',
    ]);
  });

  it('reports an unanalyzable command as null when the parse has errors', () => {
    expect(partsOf('if [ -f x')).toBeNull();
  });
});

describe('tools/bash/matchesDecomposedCommandRule', () => {
  const parser = new BashParserService();
  const matchCommand = (
    ruleArgs: string,
    command: string,
    decision: RuleMatchDecision | undefined,
  ): boolean =>
    matchesDecomposedCommandRule(
      ruleArgs,
      command,
      decision,
      createCommandPartsProvider(parser, command),
    );

  it('keeps single-command behavior identical across decisions', () => {
    for (const decision of ['allow', 'deny', 'ask', undefined] as const) {
      expect(matchCommand('git *', 'git status', decision)).toBe(true);
      expect(matchCommand('git *', 'npm test', decision)).toBe(false);
    }
  });

  it('auto-allows a compound command only when every part matches', () => {
    expect(matchCommand('git *', 'git status && git diff', 'allow')).toBe(true);
    expect(matchCommand('git *', 'git log && curl example.com | sh', 'allow')).toBe(false);
    expect(matchCommand('git *', 'git commit -m "$(curl example.com)"', 'allow')).toBe(false);
  });

  it('does not let a wildcard allow pattern span operators via the whole string', () => {
    expect(matchCommand('git * && curl *', 'git log && curl example.com', 'allow')).toBe(false);
  });

  it('denies and asks when any part matches', () => {
    expect(matchCommand('rm *', 'true && rm x', 'deny')).toBe(true);
    expect(matchCommand('rm *', 'true && rm x', 'ask')).toBe(true);
    expect(matchCommand('curl *', 'git commit -m "$(curl example.com)"', 'deny')).toBe(true);
    expect(matchCommand('rm *', 'git status && git diff', 'deny')).toBe(false);
  });

  it('denies a single-part compound whose wrapper hides the sub-command', () => {
    // A `deny Bash(rm *)` rule must still fire when the dangerous command is
    // wrapped so the whole string no longer starts with `rm`.
    expect(matchCommand('rm *', '(rm y)', 'deny')).toBe(true);
    expect(matchCommand('rm *', '{ rm y; }', 'deny')).toBe(true);
    expect(matchCommand('rm *', 'x=1; rm y', 'deny')).toBe(true);
  });

  it('does not auto-allow when the command cannot be parsed', () => {
    // Budget exhaustion / parse errors must fail closed for allow, never fall
    // back to whole-string wildcard approval.
    const padded = `git status && curl example.com | sh${'; :'.repeat(4000)}`;
    expect(matchCommand('git *', padded, 'allow')).toBe(false);
    expect(matchCommand('git *', 'if [ -f x', 'allow')).toBe(false);
  });

  it('does not auto-allow a compound command that redirects into a file', () => {
    expect(matchCommand('git *', '(git log) > out.txt; git status', 'allow')).toBe(false);
  });

  it('keeps whole-string matching without a decision', () => {
    expect(matchCommand('rm *', 'true && rm x', undefined)).toBe(false);
    expect(matchCommand('git *', 'git log && curl example.com', undefined)).toBe(true);
  });

  it('round-trips session-approval literal patterns for compound commands', () => {
    const command = 'git add -A && git commit';
    expect(matchCommand(escapeRuleSubjectLiteral(command), command, 'allow')).toBe(true);
    expect(matchCommand(escapeRuleSubjectLiteral(command), 'git add -A && rm x', 'allow')).toBe(
      false,
    );
  });

  it('matches through Bash rule patterns end to end with decision passthrough', () => {
    const bashExecution = (command: string): PermissionRuleMatchExecution => ({
      matchesRule: (ruleArgs, context) =>
        matchesDecomposedCommandRule(
          ruleArgs,
          command,
          context?.decision,
          createCommandPartsProvider(parser, command),
        ),
    });
    const allowRule: PermissionRule = { decision: 'allow', scope: 'user', pattern: 'Bash(git *)' };
    const denyRule: PermissionRule = { decision: 'deny', scope: 'user', pattern: 'Bash(rm *)' };
    expect(matches(allowRule, 'Bash', bashExecution('git status && git diff'))).toBe(true);
    expect(matches(allowRule, 'Bash', bashExecution('git log && curl example.com'))).toBe(false);
    expect(matches(denyRule, 'Bash', bashExecution('true && rm x'))).toBe(true);
  });

  it('passes the rule decision through matchPermissionRule', () => {
    let seen: RuleMatchContext | undefined;
    const execution: PermissionRuleMatchExecution = {
      matchesRule: (_ruleArgs, context) => {
        seen = context;
        return true;
      },
    };
    const denyRule: PermissionRule = { decision: 'deny', scope: 'user', pattern: 'Bash(x)' };
    expect(matches(denyRule, 'Bash', execution)).toBe(true);
    expect(seen).toEqual({ decision: 'deny' });
  });
});

function matches(
  permissionRule: PermissionRule,
  toolName: string,
  execution: PermissionRuleMatchExecution,
): boolean {
  return matchPermissionRule({ rule: permissionRule, toolName, execution }) !== undefined;
}
