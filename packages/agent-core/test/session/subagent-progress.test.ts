/**
 * SubagentProgress buffer + event formatter.
 *
 * The buffer decouples spawn-time event capture from registration-time
 * consumption: events emitted before the manager subscribes must be
 * replayed, not lost.
 */

import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '../../src/rpc';
import { formatSubagentEvent, SubagentProgress } from '../../src/session/subagent-progress';

describe('SubagentProgress', () => {
  it('replays the buffered backlog as one joined chunk, then streams live', () => {
    const progress = new SubagentProgress();
    progress.push('a');
    progress.push('b');

    const seen: string[] = [];
    progress.subscribe((chunk) => seen.push(chunk));
    expect(seen).toEqual(['ab']); // pre-subscription backlog delivered coalesced

    progress.push('c');
    expect(seen).toEqual(['ab', 'c']); // live delivery, chunk-by-chunk afterwards
  });

  it('ignores empty chunks', () => {
    const progress = new SubagentProgress();
    const seen: string[] = [];
    progress.subscribe((chunk) => seen.push(chunk));
    progress.push('');
    expect(seen).toEqual([]);
  });

  it('unsubscribe stops live delivery and re-buffers later chunks', () => {
    const progress = new SubagentProgress();
    const seen: string[] = [];
    const unsubscribe = progress.subscribe((chunk) => seen.push(chunk));

    progress.push('x');
    unsubscribe();
    progress.push('y'); // no live sink → buffered, not delivered
    expect(seen).toEqual(['x']);
  });
});

describe('formatSubagentEvent', () => {
  it('passes assistant delta text through verbatim', () => {
    const event: AgentEvent = { type: 'assistant.delta', turnId: 1, delta: 'hello' };
    expect(formatSubagentEvent(event)).toBe('hello');
  });

  it('renders a tool-call header with its description', () => {
    const event: AgentEvent = {
      type: 'tool.call.started',
      turnId: 1,
      toolCallId: 't1',
      name: 'Bash',
      args: {},
      description: 'list files',
    };
    expect(formatSubagentEvent(event)).toBe('\n\n$ Bash — list files\n');
  });

  it('renders a tool-call header without a description', () => {
    const event: AgentEvent = {
      type: 'tool.call.started',
      turnId: 1,
      toolCallId: 't1',
      name: 'Read',
      args: {},
    };
    expect(formatSubagentEvent(event)).toBe('\n\n$ Read\n');
  });

  it('renders a compact tool-result status', () => {
    const ok: AgentEvent = { type: 'tool.result', turnId: 1, toolCallId: 't1', output: 'x' };
    const err: AgentEvent = {
      type: 'tool.result',
      turnId: 1,
      toolCallId: 't1',
      output: 'x',
      isError: true,
    };
    expect(formatSubagentEvent(ok)).toBe('  ✓ done\n');
    expect(formatSubagentEvent(err)).toBe('  ✗ tool error\n');
  });

  it('skips noise events (thinking deltas, clean turn end)', () => {
    expect(formatSubagentEvent({ type: 'thinking.delta', turnId: 1, delta: 'z' })).toBeUndefined();
    expect(
      formatSubagentEvent({ type: 'turn.ended', turnId: 1, reason: 'completed' }),
    ).toBeUndefined();
  });

  it('flags an abnormal turn end', () => {
    expect(formatSubagentEvent({ type: 'turn.ended', turnId: 1, reason: 'failed' })).toBe(
      '\n[turn failed]\n',
    );
  });
});
