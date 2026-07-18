import { describe, expect, it } from 'vitest';

import { isMcpToolName, qualifyMcpToolName, sanitizeMcpNamePart } from '#/agent/mcp/tool-naming';

describe('sanitizeMcpNamePart', () => {
  it('passes alphanumeric, underscore, and dash through unchanged', () => {
    expect(sanitizeMcpNamePart('github_v2-alpha')).toBe('github_v2-alpha');
  });

  it('replaces unsafe characters with underscores', () => {
    expect(sanitizeMcpNamePart('My Search/Tool!')).toBe('My_Search_Tool_');
    expect(sanitizeMcpNamePart('@scope/pkg.tool')).toBe('_scope_pkg_tool');
  });

  it('collapses runs of underscores into a single underscore', () => {
    expect(sanitizeMcpNamePart('my__server')).toBe('my_server');
    expect(sanitizeMcpNamePart('a   b')).toBe('a_b');
    expect(sanitizeMcpNamePart('list..__issues')).toBe('list_issues');
  });
});

describe('qualifyMcpToolName', () => {
  it('joins prefix, sanitized server, and sanitized tool with double underscores', () => {
    expect(qualifyMcpToolName('github', 'list_issues')).toBe('mcp__github__list_issues');
    expect(qualifyMcpToolName('My Search', 'do.thing')).toBe('mcp__My_Search__do_thing');
  });

  it('keeps the server / tool boundary unambiguous when either half contained __', () => {
    expect(qualifyMcpToolName('my__server', 'foo')).toBe('mcp__my_server__foo');
    expect(qualifyMcpToolName('gh', 'list__issues')).toBe('mcp__gh__list_issues');
  });

  it('produces a length-capped name with a stable hash suffix when too long', () => {
    const server = 'a'.repeat(40);
    const tool = 'b'.repeat(40);
    const name = qualifyMcpToolName(server, tool);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name.startsWith('mcp__')).toBe(true);
    expect(qualifyMcpToolName(server, tool)).toBe(name);
  });

  it('differentiates servers when the tail is hashed', () => {
    const tool = 'x'.repeat(40);
    expect(qualifyMcpToolName('a'.repeat(40), tool)).not.toBe(
      qualifyMcpToolName('b'.repeat(40), tool),
    );
  });
});

describe('isMcpToolName', () => {
  it('detects qualified MCP tool names', () => {
    expect(isMcpToolName('mcp__github__list')).toBe(true);
    expect(isMcpToolName('Read')).toBe(false);
    expect(isMcpToolName('mcp_one_underscore__no')).toBe(false);
  });
});
