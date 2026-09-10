import { describe, expect, it } from 'vitest';

import {
  NotifyPanelComponent,
  type NotifyEntry,
} from '#/tui/components/chrome/notify-panel';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function render(panel: NotifyPanelComponent, width = 80): string[] {
  return panel.render(width).map(strip);
}

/** Line 0 is a blank spacer separating the box from the scrolling transcript. */
function titleOf(panel: NotifyPanelComponent, width = 80): string {
  return render(panel, width)[1]!;
}

function entry(id: string, text: string, agentId = 'main', agentName?: string): NotifyEntry {
  return { id, agentId, agentName, time: 0, text };
}

function listRows(count: number, prefix = 'row'): string {
  return Array.from({ length: count }, (_, i) => `- ${prefix} ${String(i + 1)}`).join('\n');
}

describe('NotifyPanelComponent', () => {
  it('returns no lines when empty (so the layout slot collapses)', () => {
    const panel = new NotifyPanelComponent();
    expect(panel.render(80)).toEqual([]);
    expect(panel.isEmpty()).toBe(true);
    expect(panel.focus()).toBe(false);
  });

  it('renders the update in a padded, bordered box with the channel tab', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'Login module is clean; the bug is in **session expiry**.'));
    const lines = render(panel);

    expect(lines[0]).toBe('');
    expect(lines[1]).toMatch(/^╭/);
    expect(lines[1]).toContain('main');
    expect(lines[1]).toContain('Updates 1/1');
    expect(lines[1]).toContain('ctrl+n page');
    expect(lines[1]).toMatch(/─╮$/);
    expect(lines[2]).toMatch(/^│\s*│$/);
    expect(lines[3]).toMatch(/^│  /);
    expect(lines[3]).toContain('Login module is clean; the bug is in session expiry.');
    expect(lines.at(-2)).toMatch(/^│\s*│$/);
    expect(lines.at(-1)).toMatch(/^╰─+╯$/);
  });

  it('updates an entry in place and flattens entries in display order', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'Reading the'));
    panel.upsert(entry('tc-1', 'Reading the parser first.'));
    expect(panel.getEntries().map((item) => item.text)).toEqual(['Reading the parser first.']);
    expect(render(panel).join('\n')).toContain('Reading the parser first.');
  });

  it('follows the latest activity across channels while unfocused', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'main phase one'));
    panel.upsert(entry('tc-2', 'main phase two'));
    expect(titleOf(panel)).toContain('Updates 2/2');

    panel.upsert(entry('a0:c1', 'explore finding', 'a0', 'explore'));
    const lines = render(panel);
    expect(lines[1]).toContain('main');
    expect(lines[1]).toContain('explore');
    expect(lines[1]).toContain('Updates 1/1');
    expect(lines.join('\n')).toContain('explore finding');
    expect(lines.join('\n')).not.toContain('main phase');
  });

  it('switches channels with prev/nextChannel and pages inside a channel', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'main one'));
    panel.upsert(entry('tc-2', 'main two'));
    panel.upsert(entry('a0:c1', 'explore one', 'a0', 'explore'));

    expect(panel.focus()).toBe(true);
    expect(panel.nextChannel()).toBe(false);

    expect(panel.prevChannel()).toBe(true);
    expect(titleOf(panel)).toContain('Updates 2/2');
    expect(render(panel).join('\n')).toContain('main two');

    expect(panel.prevPage()).toBe(true);
    expect(titleOf(panel)).toContain('Updates 1/2');
    expect(render(panel).join('\n')).toContain('main one');
    expect(panel.prevPage()).toBe(false);

    expect(panel.nextPage()).toBe(true);
    expect(render(panel).join('\n')).toContain('main two');
  });

  it('collects an unread dot on background channels while focused, cleared on visit', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'main one'));
    panel.upsert(entry('a0:c1', 'explore one', 'a0', 'explore'));

    panel.focus();
    panel.prevChannel();
    expect(titleOf(panel)).not.toContain('●');

    panel.upsert(entry('a0:c2', 'explore two', 'a0', 'explore'));
    expect(titleOf(panel)).toContain('explore●');
    expect(render(panel).join('\n')).toContain('main one');

    expect(panel.nextChannel()).toBe(true);
    expect(titleOf(panel)).not.toContain('●');
    expect(titleOf(panel)).toContain('Updates 2/2');
    expect(render(panel).join('\n')).toContain('explore two');
  });

  it('dedups repeated channel labels with a counter', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('a1:c1', 'first explore', 'a1', 'explore'));
    panel.upsert(entry('a2:c1', 'second explore', 'a2', 'explore'));

    expect(panel.getChannels().map((ch) => ch.label)).toEqual(['explore', 'explore(2)']);
  });

  it('labels channels by raw agent id when no name is known', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('a9:c1', 'mystery worker', 'agent-9'));
    expect(panel.getChannels().map((ch) => ch.label)).toEqual(['agent-9']);
    expect(titleOf(panel)).toContain('agent-9');
  });

  it('renders every row of a long entry — adaptive height, no truncation', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', listRows(30)));
    const text = render(panel).join('\n');
    expect(text).toContain('row 1');
    expect(text).toContain('row 30');
    expect(text).not.toContain('later lines');
    expect(text).not.toContain('more lines');
  });

  it('renders focus state: highlighted hints, blur restores', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'phase one'));

    expect(titleOf(panel)).toContain('ctrl+n page');
    panel.focus();
    expect(titleOf(panel)).toContain('← → agent · ↑ ↓ update · esc close');
    panel.blur();
    expect(panel.blur()).toBe(false);
    expect(titleOf(panel)).toContain('ctrl+n page');
  });

  it('folds to a one-line preview stub when the turn ends, expands on focus', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'phase one intro\n\n- detail one\n- detail two'));
    panel.setEnded(true);

    const collapsed = render(panel);
    expect(collapsed).toHaveLength(2);
    expect(collapsed[0]).toBe('');
    expect(collapsed[1]).toContain('▸');
    expect(collapsed[1]).toContain('main');
    expect(collapsed[1]).toContain('1 update');
    expect(collapsed[1]).toContain('phase one intro');
    expect(collapsed[1]).toContain('ctrl+n');
    expect(collapsed[1]).not.toContain('detail one');
    expect(collapsed[1]).not.toMatch(/[╭╮╰╯│]/);

    panel.focus();
    const expanded = render(panel);
    expect(expanded.join('\n')).toContain('detail one');
    expect(expanded.length).toBeGreaterThan(2);

    panel.blur();
    expect(render(panel)).toHaveLength(2);
  });

  it('stays expanded when the turn ends while the user is reading, folds on blur', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'phase one'));
    panel.focus();
    panel.setEnded(true);

    expect(render(panel).join('\n')).toContain('phase one');

    panel.blur();
    expect(render(panel)).toHaveLength(2);
  });

  it('unfolds and undims when a fresh update arrives after the turn ended', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'done with phase one'));
    panel.setEnded(true);
    expect(render(panel)).toHaveLength(2);

    panel.upsert(entry('tc-2', 'fresh turn update'));
    const lines = render(panel);
    expect(lines.join('\n')).toContain('fresh turn update');
    expect(lines[1]).not.toContain('turn ended');
  });

  it('removes an entry and drops empty channels', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'main one'));
    panel.upsert(entry('a0:c1', 'explore one', 'a0', 'explore'));

    expect(panel.remove('a0:c1')).toBe(true);
    expect(panel.getChannels().map((ch) => ch.label)).toEqual(['main']);
    expect(panel.remove('missing')).toBe(false);
  });

  it('clamps the page when the newest entry is removed', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'first'));
    panel.upsert(entry('tc-2', 'second'));
    expect(titleOf(panel)).toContain('Updates 2/2');

    expect(panel.remove('tc-2')).toBe(true);
    expect(titleOf(panel)).toContain('Updates 1/1');
    expect(panel.nextPage()).toBe(false);
  });

  it('releases focus when removal empties the panel', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'only'));
    expect(panel.focus()).toBe(true);

    expect(panel.remove('tc-1')).toBe(true);
    expect(panel.isEmpty()).toBe(true);
    expect(panel.isFocused()).toBe(false);
    expect(panel.prevPage()).toBe(false);
    expect(panel.nextPage()).toBe(false);
  });

  it('clears the unread count when a retracted entry was unread', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'main one'));
    panel.upsert(entry('a0:c1', 'explore one', 'a0', 'explore'));
    expect(panel.focus()).toBe(true);

    panel.upsert(entry('tc-2', 'main two'));
    const before = panel.getChannels().find((ch) => ch.label === 'main');
    expect(before?.unread).toBe(1);

    expect(panel.remove('tc-2')).toBe(true);
    const after = panel.getChannels().find((ch) => ch.label === 'main');
    expect(after?.unread).toBe(0);
  });

  it('keeps the unread count when a retracted entry was already read', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'main one'));
    panel.upsert(entry('a0:c1', 'explore one', 'a0', 'explore'));
    expect(panel.focus()).toBe(true);

    panel.upsert(entry('tc-2', 'delegation'));
    expect(panel.getChannels().find((ch) => ch.label === 'main')?.unread).toBe(1);

    expect(panel.prevChannel()).toBe(true);
    expect(panel.nextChannel()).toBe(true);
    panel.upsert(entry('tc-3', 'main three'));
    expect(panel.getChannels().find((ch) => ch.label === 'main')?.unread).toBe(1);

    expect(panel.remove('tc-2')).toBe(true);
    expect(panel.getChannels().find((ch) => ch.label === 'main')?.unread).toBe(1);
  });

  it('dims to a stub and notes the ended turn, and clears wholesale', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'done with phase one'));
    panel.setEnded(true);
    expect(render(panel)).toHaveLength(2);
    expect(titleOf(panel)).toContain('ctrl+n');

    panel.clear();
    expect(panel.isEmpty()).toBe(true);
    expect(panel.render(80)).toEqual([]);

    panel.upsert(entry('tc-2', 'fresh turn'));
    expect(titleOf(panel)).not.toContain('turn ended');
  });

  it('never renders wider than the requested width', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', `${'word '.repeat(60)}\n\n- a very long bullet ${'x'.repeat(120)}`));
    panel.upsert(entry('a1:c1', listRows(12, 'later'), 'a1', 'explore'));
    for (const width of [24, 40, 80]) {
      for (const line of panel.render(width)) {
        expect(strip(line).length).toBeLessThanOrEqual(width);
      }
    }
  });
});
