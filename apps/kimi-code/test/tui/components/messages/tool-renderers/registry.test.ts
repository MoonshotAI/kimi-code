import type { Component } from '@moonshot-ai/pi-tui';
import { describe, expect, it } from 'vitest';

import {
  isGenericToolResult,
  pickResultRenderer,
} from '#/tui/components/messages/tool-renderers/registry';
import { darkColors } from '#/tui/theme/colors';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';

function strip(text: string): string {
  return text.replaceAll(/\[[0-9;]*m/g, '');
}

function joinRender(components: Component[], width = 100): string {
  return components.flatMap((c) => c.render(width)).join('\n');
}

function call(name: string, args: Record<string, unknown> = {}): ToolCallBlockData {
  return { id: 'tc', name, args };
}

function result(output: string, isError = false): ToolResultBlockData {
  return { tool_call_id: 'tc', output, is_error: isError };
}

const ctx = { expanded: false, colors: darkColors };
const expandedCtx = { expanded: true, colors: darkColors };

function goalOutput(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    goal: {
      goalId: 'g1',
      objective: 'Ship feature X',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      startedBy: 'model',
      updatedBy: 'model',
      turnsUsed: 2,
      tokensUsed: 1234,
      wallClockMs: 61000,
      budget: {
        tokenBudget: null,
        turnBudget: null,
        wallClockBudgetMs: null,
        remainingTokens: null,
        remainingTurns: null,
        remainingWallClockMs: null,
        tokenBudgetReached: false,
        turnBudgetReached: false,
        wallClockBudgetReached: false,
        overBudget: false,
      },
      ...overrides,
    },
  });
}

describe('tool-result registry', () => {
  it('falls back to truncated renderer for unknown tools', () => {
    const renderer = pickResultRenderer('SomethingUnknown');
    const out = strip(joinRender(renderer(call('SomethingUnknown'), result('a\nb\nc\nd\ne'), ctx)));
    expect(out).toContain('a');
    expect(out).toContain('b');
    expect(out).toContain('c');
    expect(out).not.toContain('\nd');
    expect(out).toContain('... (2 more lines, ctrl+o to expand)');
  });

  it('uses truncated renderer for Bash to preserve raw output UX', () => {
    const renderer = pickResultRenderer('Bash');
    const out = strip(joinRender(renderer(call('Bash'), result('one\ntwo\nthree\nfour'), ctx)));
    expect(out).toContain('one');
    expect(out).toContain('... (1 more lines, ctrl+o to expand)');
  });

  it('Read renders no body when collapsed (header chip carries the count)', () => {
    const renderer = pickResultRenderer('Read');
    const out = joinRender(
      renderer(call('Read', { path: 'foo.ts' }), result('1\tfoo\n2\tbar'), ctx),
    );
    expect(out.trim()).toBe('');
  });

  it('Read expands to the raw file content when expanded', () => {
    const renderer = pickResultRenderer('Read');
    const out = strip(
      joinRender(renderer(call('Read', { path: 'foo.ts' }), result('1\tfoo\n2\tbar'), expandedCtx)),
    );
    expect(out).toContain('foo');
    expect(out).toContain('bar');
  });

  it('Grep glance lists path samples below the chip', () => {
    const renderer = pickResultRenderer('Grep');
    const out = strip(
      joinRender(
        renderer(
          call('Grep', { pattern: 'foo' }),
          result('src/a.ts\nsrc/b.ts\nsrc/c.ts\nsrc/d.ts\nsrc/e.ts'),
          ctx,
        ),
      ),
    );
    expect(out).toContain('src/a.ts');
    expect(out).toContain('src/b.ts');
    expect(out).toContain('src/c.ts');
    expect(out).toContain('+2 more');
    expect(out).not.toContain('src/d.ts');
  });

  it('Grep glance strips trailing :line:text in content mode', () => {
    const renderer = pickResultRenderer('Grep');
    const out = strip(
      joinRender(
        renderer(
          call('Grep', { pattern: 'foo' }),
          result('src/a.ts:42:    foo()\nsrc/b.ts:7:foo'),
          ctx,
        ),
      ),
    );
    expect(out).toContain('src/a.ts:42');
    expect(out).not.toContain('foo()');
  });

  it('Grep with empty result renders nothing in collapsed state', () => {
    const renderer = pickResultRenderer('Grep');
    const out = joinRender(renderer(call('Grep', { pattern: 'foo' }), result(''), ctx));
    expect(out.trim()).toBe('');
  });

  it('Glob glance lists path samples', () => {
    const renderer = pickResultRenderer('Glob');
    const out = strip(
      joinRender(
        renderer(call('Glob', { pattern: '**/*.ts' }), result('a.ts\nb.ts\nc.ts\nd.ts'), ctx),
      ),
    );
    expect(out).toContain('a.ts');
    expect(out).toContain('b.ts');
    expect(out).toContain('c.ts');
    expect(out).toContain('+1 more');
  });

  it('FetchURL renders no body when collapsed', () => {
    const renderer = pickResultRenderer('FetchURL');
    const out = joinRender(
      renderer(call('FetchURL', { url: 'https://example.com/x' }), result('<body>...'), ctx),
    );
    expect(out.trim()).toBe('');
  });

  it('WebSearch renders no body when collapsed', () => {
    const renderer = pickResultRenderer('WebSearch');
    const out = joinRender(
      renderer(call('WebSearch', { query: 'kimi' }), result('1. Alpha\n2. Beta'), ctx),
    );
    expect(out.trim()).toBe('');
  });

  it('Edit renders no body when collapsed', () => {
    const renderer = pickResultRenderer('Edit');
    const out = joinRender(
      renderer(
        call('Edit', { path: 'foo.ts', old_string: 'a', new_string: 'b' }),
        result('Replaced 1 occurrence in foo.ts'),
        ctx,
      ),
    );
    expect(out.trim()).toBe('');
  });

  it('Write renders no body when collapsed', () => {
    const renderer = pickResultRenderer('Write');
    const out = joinRender(
      renderer(call('Write', { path: 'a.txt', content: 'a\nb\n' }), result('Wrote'), ctx),
    );
    expect(out.trim()).toBe('');
  });

  it('Think renders no body even with a thought arg', () => {
    const renderer = pickResultRenderer('Think');
    const out = joinRender(renderer(call('Think', { thought: 'hello' }), result('Recorded.'), ctx));
    expect(out.trim()).toBe('');
  });

  it('GetGoal renders a compact goal summary instead of raw JSON', () => {
    const renderer = pickResultRenderer('GetGoal');
    const out = strip(joinRender(renderer(call('GetGoal'), result(goalOutput()), ctx)));
    expect(out).toContain('Goal active: Ship feature X');
    expect(out).toContain('2 turns');
    expect(out).toContain('1.2k tokens');
    expect(out).toContain('1m 01s');
    expect(out).not.toContain('"objective"');
    expect(out).not.toContain('"budget"');
  });

  it('GetGoal renders an empty goal without dumping JSON', () => {
    const renderer = pickResultRenderer('GetGoal');
    const out = strip(joinRender(renderer(call('GetGoal'), result('{"goal":null}'), ctx)));
    expect(out).toContain('No current goal.');
    expect(out).not.toContain('"goal"');
  });

  it('CreateGoal renders the created goal summary without raw JSON', () => {
    const renderer = pickResultRenderer('CreateGoal');
    const out = strip(joinRender(renderer(
      call('CreateGoal', { objective: 'Ship feature X' }),
      result(goalOutput()),
      ctx,
    )));
    expect(out).toContain('Goal active: Ship feature X');
    expect(out).not.toContain('"goalId"');
  });

  it('UpdateGoal success renders no redundant body', () => {
    const renderer = pickResultRenderer('UpdateGoal');
    const out = joinRender(
      renderer(call('UpdateGoal', { status: 'complete' }), result('Goal marked complete.'), ctx),
    );
    expect(out.trim()).toBe('');
  });

  it('Errors always fall back to truncated renderer regardless of tool', () => {
    const renderer = pickResultRenderer('Read');
    const out = strip(
      joinRender(
        renderer(call('Read', { path: 'foo.ts' }), result('ENOENT: foo.ts not found', true), ctx),
      ),
    );
    expect(out).toContain('ENOENT: foo.ts not found');
  });

  it('flags only fallback (truncated) tools as generic results', () => {
    expect(isGenericToolResult('SomethingUnknown')).toBe(true);
    expect(isGenericToolResult('mcp__server__do')).toBe(true);
    expect(isGenericToolResult('Bash')).toBe(false);
    expect(isGenericToolResult('Read')).toBe(false);
    expect(isGenericToolResult('Grep')).toBe(false);
    expect(isGenericToolResult('Edit')).toBe(false);
  });

  it('truncates unknown tool output by wrapped visual lines, not raw newlines', () => {
    const renderer = pickResultRenderer('SomethingUnknown');
    const longLine = 'x'.repeat(500);
    const out = strip(joinRender(renderer(call('SomethingUnknown'), result(longLine), ctx), 20));
    expect(out).toContain('x');
    expect(out).not.toContain(longLine);
    expect(out).toContain('... (');
  });
});
