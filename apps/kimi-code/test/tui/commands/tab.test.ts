import { describe, expect, it } from 'vitest';

import { formatTabList, parseTabCommand } from '#/tui/commands/tab';
import { isNewInTabArgument, tabArgumentCompletions } from '#/tui/commands/registry';

describe('parseTabCommand', () => {
  it('lists by default and understands the subcommands', () => {
    expect(parseTabCommand('')).toEqual({ kind: 'list' });
    expect(parseTabCommand('  list ')).toEqual({ kind: 'list' });
    expect(parseTabCommand('new')).toEqual({ kind: 'new' });
    expect(parseTabCommand('NEXT')).toEqual({ kind: 'next' });
    expect(parseTabCommand('prev')).toEqual({ kind: 'prev' });
    expect(parseTabCommand('previous')).toEqual({ kind: 'prev' });
  });

  it('selects tabs by their 1-based strip number', () => {
    expect(parseTabCommand('1')).toEqual({ kind: 'select', index: 0 });
    expect(parseTabCommand('12')).toEqual({ kind: 'select', index: 11 });
    expect(parseTabCommand('0')).toEqual({ kind: 'invalid', input: '0' });
  });

  it('parses close with an optional tab number and --force', () => {
    expect(parseTabCommand('close')).toEqual({ kind: 'close', index: undefined, force: false });
    expect(parseTabCommand('close --force')).toEqual({ kind: 'close', index: undefined, force: true });
    expect(parseTabCommand('close 3 -f')).toEqual({ kind: 'close', index: 2, force: true });
    expect(parseTabCommand('close 0')).toEqual({ kind: 'invalid', input: 'close 0' });
  });

  it('rejects unknown input', () => {
    expect(parseTabCommand('bogus')).toEqual({ kind: 'invalid', input: 'bogus' });
  });
});

describe('formatTabList', () => {
  it('marks the active tab and numbers the rest', () => {
    const out = formatTabList(
      [
        { sessionId: 'a', title: 'Alpha', status: 'idle', unread: false },
        { sessionId: 'b', title: null, status: 'running', unread: true },
      ],
      1,
    );
    expect(out.split('\n')).toEqual(['Tabs (2):', '  1 Alpha', '▸ 2● b •']);
    expect(formatTabList([], -1)).toBe('No tabs open.');
  });
});

describe('/new and /tab argument helpers', () => {
  it('recognises the new-tab argument', () => {
    expect(isNewInTabArgument('tab')).toBe(true);
    expect(isNewInTabArgument(' --tab ')).toBe(true);
    expect(isNewInTabArgument('')).toBe(false);
    expect(isNewInTabArgument('tabs')).toBe(false);
  });

  it('completes /tab subcommands', () => {
    expect(tabArgumentCompletions('c')?.map((item) => item.value)).toEqual(['close']);
    expect(tabArgumentCompletions('')?.map((item) => item.value)).toEqual([
      'list',
      'new',
      'next',
      'prev',
      'close',
    ]);
  });
});
