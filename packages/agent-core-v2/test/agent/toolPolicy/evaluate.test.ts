import { describe, expect, it } from 'vitest';

import {
  findInactiveToolPatterns,
  isToolActive,
  isToolActiveComposed,
  literalToolNames,
} from '#/agent/toolPolicy/evaluate';

describe('findInactiveToolPatterns', () => {
  const known = new Set(['Read', 'Bash', 'Skill']);
  const isKnown = (name: string): boolean => known.has(name);

  it('passes literal known tool names and MCP globs', () => {
    expect(
      findInactiveToolPatterns(['Read', 'Bash', 'mcp__github__*', 'mcp__*'], isKnown),
    ).toEqual([]);
  });

  it('flags a name that matches no known tool (typo, wrong case)', () => {
    expect(findInactiveToolPatterns(['Bashh', 'read'], isKnown)).toEqual([
      { pattern: 'Bashh', kind: 'unknown-tool' },
      { pattern: 'read', kind: 'unknown-tool' },
    ]);
  });

  it('flags a bare * as never matching, and the evaluator agrees', () => {
    expect(findInactiveToolPatterns(['*'])).toEqual([{ pattern: '*', kind: 'wildcard-not-mcp' }]);
    expect(isToolActive({ tools: ['*'] }, 'Read')).toBe(false);
    expect(isToolActive({ tools: ['*'] }, 'mcp__github__create_pr', 'mcp')).toBe(false);
    expect(isToolActive({ disallowedTools: ['*'] }, 'Read')).toBe(true);
  });

  it('flags wildcards without the mcp__ prefix', () => {
    expect(findInactiveToolPatterns(['Bash*'])).toEqual([
      { pattern: 'Bash*', kind: 'wildcard-not-mcp' },
    ]);
  });

  it('flags an mcp__ literal that is not a full server__tool name', () => {
    expect(findInactiveToolPatterns(['mcp__github', 'mcp__'])).toEqual([
      { pattern: 'mcp__github', kind: 'incomplete-mcp-name' },
      { pattern: 'mcp__', kind: 'incomplete-mcp-name' },
    ]);
  });

  it('passes a full mcp__server__tool literal', () => {
    expect(findInactiveToolPatterns(['mcp__github__create_issue'], isKnown)).toEqual([]);
  });

  it('skips the unknown-tool check when no vocabulary is provided', () => {
    expect(findInactiveToolPatterns(['AnythingGoes'])).toEqual([]);
  });
});

describe('literalToolNames', () => {
  it('keeps only literal non-MCP names', () => {
    expect(
      literalToolNames(['Read', 'mcp__*', 'Bash*', 'mcp__github__create_issue']),
    ).toEqual(['Read']);
  });
});

describe('isToolActiveComposed workspace veto', () => {
  it('lets the workspace layer veto a tool every other layer allows', () => {
    expect(
      isToolActiveComposed(
        {
          workspaceDisabledTools: ['Bash'],
          profile: { tools: ['Bash', 'Read'] },
          global: { enabled: ['Bash', 'Read'] },
          sessionDisabledTools: [],
        },
        'Bash',
      ),
    ).toBe(false);
    expect(
      isToolActiveComposed(
        {
          workspaceDisabledTools: ['Bash'],
          profile: { tools: ['Bash', 'Read'] },
        },
        'Read',
      ),
    ).toBe(true);
  });

  it('applies the workspace veto to MCP tools by glob', () => {
    expect(
      isToolActiveComposed(
        { workspaceDisabledTools: ['mcp__blocked__*'], profile: {} },
        'mcp__blocked__write',
        'mcp',
      ),
    ).toBe(false);
  });

  it('stays inactive when any classic layer also denies', () => {
    expect(
      isToolActiveComposed(
        {
          workspaceDisabledTools: ['Bash'],
          profile: {},
          sessionDisabledTools: ['Bash'],
        },
        'Bash',
      ),
    ).toBe(false);
  });
});
