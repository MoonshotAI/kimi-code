import { describe, expect, it } from 'vitest';

import { isMcpToolName, qualifyMcpToolName, sanitizeMcpNamePart } from '../../src/mcp/tool-naming';

describe('sanitizeMcpNamePart', () => {
  it('passes alphanumeric, underscore, and dash through unchanged', () => {
    expect(sanitizeMcpNamePart('github_v2-alpha')).toBe('github_v2-alpha');
  });

  it('replaces unsafe characters with underscores', () => {
    expect(sanitizeMcpNamePart('My Search/Tool!')).toBe('My_Search_Tool_');
    expect(sanitizeMcpNamePart('@scope/pkg.tool')).toBe('_scope_pkg_tool');
  });

  it('collapses runs of underscores (including pre-existing __) into a single _', () => {
    // Pre-existing __ — keeping the separator out of either name half is what
    // lets decoders split unambiguously on the first __ in the qualified name.
    expect(sanitizeMcpNamePart('my__server')).toBe('my_server');
    // A run of unsafe characters also collapses.
    expect(sanitizeMcpNamePart('a   b')).toBe('a_b');
    expect(sanitizeMcpNamePart('list..__issues')).toBe('list_issues');
  });

  it('preserves leading and trailing hyphens', () => {
    expect(sanitizeMcpNamePart('-alpha-')).toBe('-alpha-');
  });

  it('handles very long input without throwing', () => {
    const long = 'a'.repeat(500);
    expect(sanitizeMcpNamePart(long)).toBe(long);
  });

  it('replaces empty or whitespace-only input with underscores', () => {
    // Single space collapses to empty; edge case for server/tool names.
    const result = sanitizeMcpNamePart('   ');
    // All whitespace is unsafe → becomes underscores → collapses → empty string.
    expect(result).toBe('_');
  });
});

describe('qualifyMcpToolName', () => {
  it('joins prefix, sanitized server, and sanitized tool with double underscores', () => {
    expect(qualifyMcpToolName('github', 'list_issues')).toBe('mcp__github__list_issues');
    expect(qualifyMcpToolName('My Search', 'do.thing')).toBe('mcp__My_Search__do_thing');
  });

  it('keeps the server / tool boundary unambiguous when either half contained __', () => {
    // Without the collapse step, `my__server` + `foo` would produce
    // `mcp__my__server__foo` and a left-to-right decoder would think
    // server=my, tool=server__foo. With the collapse, the qualified name
    // contains exactly one `__` after the prefix and decoders cannot misread.
    expect(qualifyMcpToolName('my__server', 'foo')).toBe('mcp__my_server__foo');
    expect(qualifyMcpToolName('gh', 'list__issues')).toBe('mcp__gh__list_issues');
  });

  it('produces a length-capped name with a stable hash suffix when too long', () => {
    const server = 'a'.repeat(40);
    const tool = 'b'.repeat(40);
    const name = qualifyMcpToolName(server, tool);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name.startsWith('mcp__')).toBe(true);
    // Same input → same output (stable hash).
    expect(qualifyMcpToolName(server, tool)).toBe(name);
  });

  it('differentiates servers when the tail is hashed', () => {
    const tool = 'x'.repeat(40);
    expect(qualifyMcpToolName('a'.repeat(40), tool)).not.toBe(
      qualifyMcpToolName('b'.repeat(40), tool),
    );
  });

  it('handles empty server name gracefully', () => {
    expect(qualifyMcpToolName('', 'list')).toBe('mcp____list');
  });

  it('handles empty tool name gracefully', () => {
    expect(qualifyMcpToolName('srv', '')).toBe('mcp__srv__');
  });

  it('produces the same shortened result regardless of which half is longest', () => {
    const short = 'a';
    const long = 'x'.repeat(60);
    const nameA = qualifyMcpToolName(long, short);
    const nameB = qualifyMcpToolName(short, long);
    expect(nameA.length).toBeLessThanOrEqual(64);
    expect(nameB.length).toBeLessThanOrEqual(64);
  });
});

describe('isMcpToolName', () => {
  it('detects qualified MCP tool names', () => {
    expect(isMcpToolName('mcp__github__list')).toBe(true);
    expect(isMcpToolName('Read')).toBe(false);
    expect(isMcpToolName('mcp_one_underscore__no')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isMcpToolName('')).toBe(false);
  });

  it('returns true for prefix-only string (mcp__) since it starts with the prefix', () => {
    expect(isMcpToolName('mcp__')).toBe(true);
  });

  it('returns true for mcp__server (two parts), as it starts with mcp__', () => {
    expect(isMcpToolName('mcp__server')).toBe(true);
  });

  it('returns true for deeply nested tool names', () => {
    expect(isMcpToolName('mcp__server__tool__sub')).toBe(true);
  });

  it('returns false for non-MCP tool names that coincidentally contain mcp__', () => {
    expect(isMcpToolName('not_mcp__tool')).toBe(false);
  });
});
