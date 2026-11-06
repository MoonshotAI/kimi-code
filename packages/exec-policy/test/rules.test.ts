import { describe, expect, it } from 'vitest';

import { BUILTIN_RULES } from '../src/builtinRules';
import {
  evaluateArgv,
  evaluateHost,
  evaluateSegments,
} from '../src/evaluate';
import { RulesSyntaxError, parseRulesFile } from '../src/rulesFile';
import type { ExecRule } from '../src/types';

describe('parseRulesFile', () => {
  it('parses prefix_rule and network_rule calls', () => {
    const rules = parseRulesFile(
      [
        '# comment',
        'prefix_rule(pattern = ["git", "status"], decision = "allow", justification = "read only")',
        "network_rule(host = 'example.com', protocol = 'https', decision = 'prompt')",
      ].join('\n'),
      'user',
    );
    expect(rules).toEqual([
      {
        kind: 'prefix_rule',
        pattern: ['git', 'status'],
        decision: 'allow',
        justification: 'read only',
        source: 'user',
      },
      {
        kind: 'network_rule',
        host: 'example.com',
        protocol: 'https',
        decision: 'prompt',
        justification: undefined,
        source: 'user',
      },
    ]);
  });

  it('accepts trailing commas, blank lines, and mixed quotes', () => {
    const rules = parseRulesFile(
      '\nprefix_rule(\n  pattern = ["a",],\n  decision = "allow",\n)\n',
      'project',
    );
    expect(rules[0]).toMatchObject({ pattern: ['a'], source: 'project' });
  });

  it('rejects unknown rule names', () => {
    expect(() => parseRulesFile('glob_rule(pattern = ["x"])', 'user')).toThrow(
      RulesSyntaxError,
    );
  });

  it('rejects invalid decision values', () => {
    expect(() =>
      parseRulesFile('prefix_rule(pattern = ["x"], decision = "maybe")', 'user'),
    ).toThrow(RulesSyntaxError);
  });

  it('rejects missing pattern and empty pattern', () => {
    expect(() => parseRulesFile('prefix_rule(decision = "allow")', 'user')).toThrow(
      RulesSyntaxError,
    );
    expect(() =>
      parseRulesFile('prefix_rule(pattern = [], decision = "allow")', 'user'),
    ).toThrow(RulesSyntaxError);
  });

  it('reports line and column on syntax errors', () => {
    try {
      parseRulesFile('prefix_rule(pattern = ["a"]\n  decision = "allow")', 'user');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RulesSyntaxError);
      expect((error as RulesSyntaxError).line).toBe(2);
    }
  });

  it('rejects non-string pattern elements', () => {
    expect(() =>
      parseRulesFile('prefix_rule(pattern = [1], decision = "allow")', 'user'),
    ).toThrow(RulesSyntaxError);
  });
});

describe('evaluateArgv', () => {
  const allowLs: ExecRule = {
    kind: 'prefix_rule',
    pattern: ['ls'],
    decision: 'allow',
    source: 'user',
  };
  const promptCurl: ExecRule = {
    kind: 'prefix_rule',
    pattern: ['curl'],
    decision: 'prompt',
    source: 'project',
  };

  it('matches argv prefixes exactly', () => {
    expect(evaluateArgv([allowLs], ['ls', '-la']).decision).toBe('allow');
    expect(evaluateArgv([allowLs], ['lsblk']).decision).toBe('none');
    expect(evaluateArgv([promptCurl], ['curl', 'https://example.com']).decision).toBe(
      'prompt',
    );
  });

  it('prefers forbidden over prompt and allow', () => {
    const rules: ExecRule[] = [
      allowLs,
      { kind: 'prefix_rule', pattern: ['ls'], decision: 'prompt', source: 'user' },
      { kind: 'prefix_rule', pattern: ['ls', '-x'], decision: 'forbidden', source: 'builtin' },
    ];
    expect(evaluateArgv(rules, ['ls', '-x']).decision).toBe('forbidden');
    expect(evaluateArgv(rules, ['ls', '-y']).decision).toBe('prompt');
  });

  it('cannot be softened by a lower-precedence layer', () => {
    const rules: ExecRule[] = [
      { kind: 'prefix_rule', pattern: ['rm'], decision: 'forbidden', source: 'managed' },
      { kind: 'prefix_rule', pattern: ['rm'], decision: 'allow', source: 'project' },
    ];
    expect(evaluateArgv(rules, ['rm', 'x']).decision).toBe('forbidden');
  });

  it('reports the highest-precedence matching rule for provenance', () => {
    const managed: ExecRule = {
      kind: 'prefix_rule',
      pattern: ['curl'],
      decision: 'prompt',
      source: 'managed',
      justification: 'egress',
    };
    const project: ExecRule = { ...promptCurl };
    const result = evaluateArgv([project, managed], ['curl', 'x']);
    expect(result.decision).toBe('prompt');
    expect(result.matchedRule?.source).toBe('managed');
    expect(result.matchedRule?.justification).toBe('egress');
  });

  it('builtin forbidden beats user allow', () => {
    const rules: ExecRule[] = [
      ...BUILTIN_RULES,
      { kind: 'prefix_rule', pattern: ['rm', '-rf', '/'], decision: 'allow', source: 'user' },
    ];
    expect(evaluateArgv(rules, ['rm', '-rf', '/']).decision).toBe('forbidden');
  });
});

describe('evaluateHost', () => {
  const rules: ExecRule[] = [
    {
      kind: 'network_rule',
      host: '*.example.com',
      decision: 'allow',
      source: 'user',
    },
    {
      kind: 'network_rule',
      host: 'blocked.example.com',
      decision: 'forbidden',
      source: 'user',
    },
    {
      kind: 'network_rule',
      host: 'x.example.com',
      protocol: 'https',
      decision: 'prompt',
      source: 'user',
    },
  ];

  it('matches exact hosts and *. wildcards including the apex', () => {
    expect(evaluateHost(rules, 'a.example.com').decision).toBe('allow');
    expect(evaluateHost(rules, 'example.com').decision).toBe('allow');
    expect(evaluateHost(rules, 'other.com').decision).toBe('none');
  });

  it('forbidden beats wildcard allow on the same host', () => {
    expect(evaluateHost(rules, 'blocked.example.com').decision).toBe('forbidden');
  });

  it('honors the protocol filter', () => {
    expect(evaluateHost(rules, 'x.example.com', 'https').decision).toBe('prompt');
    expect(evaluateHost(rules, 'x.example.com', 'http').decision).toBe('allow');
  });
});

describe('evaluateSegments', () => {
  const rules: ExecRule[] = [
    { kind: 'prefix_rule', pattern: ['git', 'status'], decision: 'allow', source: 'builtin' },
    { kind: 'prefix_rule', pattern: ['curl'], decision: 'prompt', source: 'builtin' },
    { kind: 'prefix_rule', pattern: ['rm', '-rf', '/'], decision: 'forbidden', source: 'builtin' },
  ];

  it('returns the most restrictive verdict across segments', () => {
    const result = evaluateSegments(rules, [
      ['git', 'status'],
      ['curl', 'x'],
    ]);
    expect(result.verdict).toBe('prompt');
    expect(
      evaluateSegments(rules, [
        ['git', 'status'],
        ['rm', '-rf', '/'],
      ]).verdict,
    ).toBe('forbidden');
    expect(evaluateSegments(rules, [['git', 'status']]).verdict).toBe('allow');
    expect(evaluateSegments(rules, [['echo', 'hi']]).verdict).toBe('none');
  });

  it('marks commands containing unanalyzable segments', () => {
    expect(evaluateSegments(rules, [['git', 'status'], null]).verdict).toBe(
      'unanalyzable',
    );
    expect(evaluateSegments(rules, [null]).verdict).toBe('unanalyzable');
  });
});
