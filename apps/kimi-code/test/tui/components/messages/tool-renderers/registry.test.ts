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
  it('falls back to truncated renderer for unknown tools: first line marked, full when expanded', () => {
    const renderer = pickResultRenderer('SomethingUnknown');
    const collapsed = strip(
      joinRender(renderer(call('SomethingUnknown'), result('\na\nb\nc\nd\ne'), ctx)),
    );
    expect(collapsed).toBe('  a …');

    const expanded = strip(
      joinRender(renderer(call('SomethingUnknown'), result('a\nb\nc\nd\ne'), expandedCtx)),
    );
    expect(expanded).toContain('a');
    expect(expanded).toContain('e');
    expect(expanded).not.toContain('ctrl+o to expand');
  });

  it('keeps a failing unknown tool\'s output previewed while collapsed', () => {
    const renderer = pickResultRenderer('SomethingUnknown');
    const out = strip(
      joinRender(
        renderer(call('SomethingUnknown'), result('a\nb\nc\nd\ne', true), ctx),
      ),
    );
    expect(out).toContain('a');
    expect(out).toContain('c');
    expect(out).not.toContain('\nd');
    expect(out).toContain('… (2 more lines, ctrl+o to expand)');
  });

  it('uses the shell renderer for Bash: marked last line collapsed, raw output expanded', () => {
    const renderer = pickResultRenderer('Bash');
    expect(strip(joinRender(renderer(call('Bash'), result('one\ntwo\nthree\nfour'), ctx)))).toBe(
      '  … four',
    );
    const out = strip(
      joinRender(renderer(call('Bash'), result('one\ntwo\nthree\nfour'), expandedCtx)),
    );
    expect(out).toContain('one');
    expect(out).toContain('four');
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

  it('Grep renders its glance as the outcome row when collapsed', () => {
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
    expect(out).toBe('  src/a.ts, src/b.ts, src/c.ts, +2 more');
  });

  it('keeps the "+N more" count when the glance samples overflow the width', () => {
    const renderer = pickResultRenderer('Grep');
    const out = strip(
      joinRender(
        renderer(
          call('Grep', { pattern: 'foo' }),
          result('src/aaaa.ts\nsrc/bbbb.ts\nsrc/cccc.ts\nsrc/dddd.ts\nsrc/eeee.ts'),
          ctx,
        ),
        40,
      ),
    );
    // The samples are cut to fit; the count in the fixed tail always survives.
    expect(out.endsWith(', +2 more')).toBe(true);
    expect(out).toContain('…');
  });

  it('Grep glance lists path samples above the raw output when expanded', () => {
    const renderer = pickResultRenderer('Grep');
    const out = strip(
      joinRender(
        renderer(
          call('Grep', { pattern: 'foo' }),
          result('src/a.ts\nsrc/b.ts\nsrc/c.ts\nsrc/d.ts\nsrc/e.ts'),
          expandedCtx,
        ),
      ),
    );
    expect(out).toContain('src/a.ts, src/b.ts, src/c.ts, +2 more');
    expect(out).toContain('src/d.ts');
  });

  it('Grep glance strips trailing :line:text in content mode', () => {
    const renderer = pickResultRenderer('Grep');
    const out = strip(
      joinRender(
        renderer(
          call('Grep', { pattern: 'foo', output_mode: 'content' }),
          result('src/a.ts:42:    foo()\nsrc/b.ts:7:foo'),
          expandedCtx,
        ),
      ),
    );
    expect(out).toContain('src/a.ts:42, src/b.ts:7');
  });

  it('Grep glance skips the count_matches summary line', () => {
    const renderer = pickResultRenderer('Grep');
    const out = strip(
      joinRender(
        renderer(
          call('Grep', { pattern: 'foo', output_mode: 'count_matches' }),
          result('Found 5 total occurrences across 2 files.\nsrc/a.ts:3\nsrc/b.ts:2'),
          ctx,
        ),
      ),
    );
    expect(out).toBe('  src/a.ts:3, src/b.ts:2');
  });

  it('shows a short unknown-tool output whole while collapsed', () => {
    const renderer = pickResultRenderer('SomethingUnknown');
    expect(strip(joinRender(renderer(call('SomethingUnknown'), result('a\nb'), ctx)))).toBe(
      '  a\n  b',
    );
  });

  it('Grep with empty result renders nothing in collapsed state', () => {
    const renderer = pickResultRenderer('Grep');
    const out = joinRender(renderer(call('Grep', { pattern: 'foo' }), result(''), ctx));
    expect(out.trim()).toBe('');
  });

  it('Glob glance lists path samples when expanded', () => {
    const renderer = pickResultRenderer('Glob');
    expect(
      strip(
        joinRender(
          renderer(call('Glob', { pattern: '**/*.ts' }), result('a.ts\nb.ts\nc.ts\nd.ts'), ctx),
        ),
      ),
    ).toBe('  a.ts, b.ts, c.ts, +1 more');
    const out = strip(
      joinRender(
        renderer(
          call('Glob', { pattern: '**/*.ts' }),
          result('a.ts\nb.ts\nc.ts\nd.ts'),
          expandedCtx,
        ),
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

  it('truncates a failing unknown tool\'s output by wrapped visual lines, not raw newlines', () => {
    const renderer = pickResultRenderer('SomethingUnknown');
    const longLine = 'x'.repeat(500);
    const out = strip(
      joinRender(renderer(call('SomethingUnknown'), result(longLine, true), ctx), 20),
    );
    expect(out).toContain('x');
    expect(out).not.toContain(longLine);
    expect(out).toContain('… (');
  });

  const waitForCompletedOutput = [
    'wait_status: completed',
    'task_id: question-80w0h7nw',
    'waited_ms: 9607',
    'timeout_ms: 300000',
    '',
    '[finished]',
    'task_id: question-80w0h7nw',
    'description: Pick one so I can demonstrate WaitFor with background questions?',
    'status: completed',
    'kind: question',
    '',
    '[output]',
    '{"answers":{"Pick one":"Beta"}}',
  ].join('\n');

  it('WaitFor completed renders the finished task instead of raw fields', () => {
    const renderer = pickResultRenderer('WaitFor');
    const out = strip(
      joinRender(
        renderer(call('WaitFor', { task_id: 'question-80w0h7nw' }), result(waitForCompletedOutput), ctx),
      ),
    );
    expect(out).toContain('✓ question-80w0h7nw completed');
    expect(out).toContain('Pick one so I can demonstrate');
    expect(out).not.toContain('waited_ms');
    expect(out).not.toContain('[finished]');
  });

  it('WaitFor completed expands to the raw timeline output', () => {
    const renderer = pickResultRenderer('WaitFor');
    const out = strip(
      joinRender(
        renderer(
          call('WaitFor', { task_id: 'question-80w0h7nw' }),
          result(waitForCompletedOutput),
          expandedCtx,
        ),
      ),
    );
    expect(out).toContain('[finished]');
    expect(out).toContain('waited_ms: 9607');
  });

  it('WaitFor completed mentions extras and still-running counts', () => {
    const output = [
      'wait_status: completed',
      'task_id: bash-a1',
      'waited_ms: 1200',
      'timeout_ms: 30000',
      '',
      '[finished]',
      'task_id: bash-a1',
      'description: main wait',
      'status: failed',
      '',
      '[completed_during_wait]',
      'task_id: bash-b2',
      'description: side task',
      'status: completed',
      '',
      '[still_running]',
      'active_background_tasks: 2',
      'task_id: bash-c3',
      'description: slow one',
      'status: running',
      '---',
      'task_id: agent-d4',
      'description: another slow one',
      'status: running',
    ].join('\n');
    const renderer = pickResultRenderer('WaitFor');
    const out = strip(joinRender(renderer(call('WaitFor', { task_id: 'bash-a1' }), result(output), ctx)));
    expect(out).toContain('✗ bash-a1 failed');
    expect(out).toContain('+1 more finished during wait');
    expect(out).toContain('2 background tasks still running');
  });

  it('WaitFor timed_out lists the still-running tasks without an error tone', () => {
    const output = [
      'wait_status: timed_out',
      'task_id: bash-a1',
      'waited_ms: 30000',
      'timeout_ms: 30000',
      'The wait ended before the task finished.',
      '',
      '[still_running]',
      'active_background_tasks: 2',
      'task_id: bash-a1',
      'description: bg sleep',
      'status: running',
      '---',
      'task_id: agent-b2',
      'description: investigate flaky test',
      'status: running',
    ].join('\n');
    const renderer = pickResultRenderer('WaitFor');
    const out = strip(joinRender(renderer(call('WaitFor', { task_id: 'bash-a1' }), result(output), ctx)));
    expect(out).toContain('2 background tasks still running');
    expect(out).toContain('bg sleep');
    expect(out).toContain('investigate flaky test');
    expect(out).not.toContain('waited_ms');
  });

  it('WaitFor no_tasks renders no body in collapsed state', () => {
    const renderer = pickResultRenderer('WaitFor');
    const output = 'wait_status: no_tasks\nwaited_ms: 0\ntimeout_ms: 30000';
    const out = joinRender(renderer(call('WaitFor', { timeout: 30 }), result(output), ctx));
    expect(out.trim()).toBe('');
  });

  it('WaitFor errors fall back to the truncated renderer', () => {
    const renderer = pickResultRenderer('WaitFor');
    const out = strip(
      joinRender(
        renderer(call('WaitFor', { task_id: 'bash-x' }), result('Task not found: bash-x', true), ctx),
      ),
    );
    expect(out).toContain('Task not found: bash-x');
  });
});

describe('outcome rows', () => {
  function plain(text: string): string {
    return text.replaceAll(/\[[0-9;]*m/g, '');
  }

  it('lists each file once in an unnumbered Grep glance', () => {
    const renderer = pickResultRenderer('Grep');
    const out = plain(
      joinRender(
        renderer(
          call('Grep', { pattern: 'foo', output_mode: 'content', '-n': false }),
          result('a.ts:foo\na.ts:foo again\nb.ts:foo'),
          ctx,
        ),
      ),
    );
    expect(out).toBe('  a.ts, b.ts');
  });

  it('strips terminal colours from an outcome row', () => {
    const renderer = pickResultRenderer('Bash');
    const rows = renderer(
      call('Bash', { command: 'pnpm test' }),
      result('[31mFAIL[0m src/a.test.ts'),
      ctx,
    ).flatMap((component) => component.render(100));
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toContain('[31m');
    expect(plain(rows[0] ?? '')).toBe('  FAIL src/a.test.ts');
  });
});
