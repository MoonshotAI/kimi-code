import { describe, expect, it } from 'vitest';

import type { PermissionRule } from '#/permissionRules/permissionRules';
import {
  matchPermissionRule,
  parsePattern,
} from '#/permissionRules/matchesRule';
import type { PermissionRuleMatchExecution } from '#/permissionRules/matchesRule';

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
});
