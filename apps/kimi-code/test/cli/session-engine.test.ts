import type { Event } from '@moonshot-ai/kimi-code-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { formatSessionPrintEvent, isSessionEngineEnabled } from '#/cli/session-engine';

const base = { sessionId: 's1', agentId: 'main' } as const;

describe('isSessionEngineEnabled (Track F: print default-on)', () => {
  const prior = process.env['KIMI_SESSION_ENGINE'];
  afterEach(() => {
    if (prior === undefined) delete process.env['KIMI_SESSION_ENGINE'];
    else process.env['KIMI_SESSION_ENGINE'] = prior;
  });

  it('is on by default (unset)', () => {
    delete process.env['KIMI_SESSION_ENGINE'];
    expect(isSessionEngineEnabled()).toBe(true);
  });

  it('stays on for any value except "0"', () => {
    process.env['KIMI_SESSION_ENGINE'] = '1';
    expect(isSessionEngineEnabled()).toBe(true);
  });

  it('opts out only with "0"', () => {
    process.env['KIMI_SESSION_ENGINE'] = '0';
    expect(isSessionEngineEnabled()).toBe(false);
  });
});

describe('formatSessionPrintEvent', () => {
  it('renders assistant text to stdout', () => {
    const event = { ...base, type: 'assistant.delta', turnId: 1, delta: 'hello' } as Event;
    const out = formatSessionPrintEvent(event, new Map());
    expect(out.stdout).toBe('hello');
    expect(out.stderr).toBeUndefined();
  });

  it('renders a tool call to stderr with an argument preview and records the name', () => {
    const toolNames = new Map<string, string>();
    const event = {
      ...base,
      type: 'tool.call.started',
      turnId: 1,
      toolCallId: 'c1',
      name: 'Read',
      args: { path: 'a.txt' },
    } as Event;
    const out = formatSessionPrintEvent(event, toolNames);
    expect(out.stdout).toBeUndefined();
    expect(out.stderr).toContain('[tool] Read');
    expect(out.stderr).toContain('a.txt');
    // The name is remembered so the paired result can name the tool.
    expect(toolNames.get('c1')).toBe('Read');
  });

  it('names a successful tool result from the recorded call id', () => {
    const toolNames = new Map<string, string>([['c1', 'Read']]);
    const event = {
      ...base,
      type: 'tool.result',
      turnId: 1,
      toolCallId: 'c1',
      output: 'file contents',
      isError: false,
    } as Event;
    const out = formatSessionPrintEvent(event, toolNames);
    expect(out.stderr).toBe('[tool] Read ok\n');
  });

  it('surfaces the first line of a failed tool result', () => {
    const toolNames = new Map<string, string>([['c2', 'Bash']]);
    const event = {
      ...base,
      type: 'tool.result',
      turnId: 1,
      toolCallId: 'c2',
      output: 'boom: permission denied\nstack trace line 2',
      isError: true,
    } as Event;
    const out = formatSessionPrintEvent(event, toolNames);
    expect(out.stderr).toContain('[tool] Bash failed: boom: permission denied');
    expect(out.stderr).not.toContain('stack trace line 2');
  });

  it('ignores events with no print representation (e.g. goal updates)', () => {
    const event = { ...base, type: 'goal.updated', turnId: 1, status: 'active' } as unknown as Event;
    const out = formatSessionPrintEvent(event, new Map());
    expect(out).toEqual({});
  });
});
