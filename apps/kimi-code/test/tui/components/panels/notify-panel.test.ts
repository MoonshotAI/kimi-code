import { describe, expect, it } from 'vitest';

import { NotifyPanelComponent } from '#/tui/components/chrome/notify-panel';
import { NOTIFY_PANEL_MAX_BODY_LINES } from '#/tui/constant/rendering';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function render(panel: NotifyPanelComponent, width = 80): string[] {
  return panel.render(width).map(strip);
}

/** Body rows only: everything after the separator and the title. */
function body(panel: NotifyPanelComponent, width = 80): string[] {
  return render(panel, width).slice(2);
}

function listRows(count: number, prefix = 'row'): string {
  return Array.from({ length: count }, (_, i) => `- ${prefix} ${String(i + 1)}`).join('\n');
}

describe('NotifyPanelComponent', () => {
  it('returns no lines when empty (so the layout slot collapses)', () => {
    const panel = new NotifyPanelComponent();
    expect(panel.render(80)).toEqual([]);
    expect(panel.isEmpty()).toBe(true);
    expect(panel.hasMorePages()).toBe(false);
    expect(panel.nextPage()).toBe(false);
  });

  it('renders a separator, an Update title, and the message as markdown behind a marker', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert('tc-1', 'Login module is clean; the bug is in **session expiry**.');
    const lines = render(panel);
    expect(lines[0]).toMatch(/^─+$/);
    expect(lines[1]).toContain('◆ Update');
    expect(lines[1]).not.toContain('Updates');
    expect(lines[1]).not.toContain('ctrl+n');
    expect(lines[2]).toContain('◆ Login module is clean; the bug is in session expiry.');
    expect(panel.hasMorePages()).toBe(false);
  });

  it('updates an entry in place while its message streams', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert('tc-1', 'Reading the');
    panel.upsert('tc-1', 'Reading the parser first.');
    expect(panel.getEntries()).toEqual([{ id: 'tc-1', text: 'Reading the parser first.' }]);
    expect(body(panel).join('\n')).toContain('Reading the parser first.');
  });

  it('stacks the updates of a turn, newest last, with the newest marked solid', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert('tc-1', 'plan: three parallel probes');
    panel.upsert('tc-2', 'core side done');
    panel.upsert('tc-3', 'running the full test suite now, ~3 minutes');

    const lines = render(panel);
    expect(lines[1]).toContain('◆ Updates (3)');
    expect(lines[1]).not.toContain('ctrl+n');
    expect(body(panel)).toEqual([
      expect.stringContaining('◇ plan: three parallel probes'),
      expect.stringContaining('◇ core side done'),
      expect.stringContaining('◆ running the full test suite now, ~3 minutes'),
    ]);
  });

  it('indents continuation rows of a multi-line update under its marker', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert('tc-1', 'first paragraph\n\nsecond paragraph');
    const rows = body(panel);
    expect(rows[0]).toMatch(/^  ◆ first paragraph/);
    expect(rows.at(-1)).toMatch(/^ {4}second paragraph/);
  });

  it('follows the tail when the stack overflows, pages up with wrap-around', () => {
    const panel = new NotifyPanelComponent();
    const total = NOTIFY_PANEL_MAX_BODY_LINES + 3;
    panel.upsert('tc-1', listRows(total));

    // Tail window: the last `cap` rows, with an "earlier" hint above.
    let lines = render(panel);
    expect(lines[1]).toContain('ctrl+n earlier');
    expect(lines[2]).toContain('… 3 earlier lines');
    expect(lines.slice(3).join('\n')).toContain(`row ${String(total)}`);
    expect(lines.slice(3).join('\n')).not.toContain('row 1\n');
    expect(lines.at(-1)).not.toContain('later lines');
    expect(panel.hasMorePages()).toBe(true);

    // Page up: the first rows, with a "later" hint below.
    expect(panel.nextPage()).toBe(true);
    lines = render(panel);
    expect(lines[2]).toContain('◆ • row 1');
    expect(lines.join('\n')).not.toContain('earlier lines');
    expect(lines.at(-1)).toContain('… 3 later lines');

    // From the top, wrap back to the tail.
    expect(panel.nextPage()).toBe(true);
    lines = render(panel);
    expect(lines[2]).toContain('… 3 earlier lines');
    expect(lines.slice(3).join('\n')).toContain(`row ${String(total)}`);
  });

  it('snaps back to the tail when a new update arrives while paged up', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert('tc-1', listRows(NOTIFY_PANEL_MAX_BODY_LINES + 2));
    render(panel);
    expect(panel.nextPage()).toBe(true);
    expect(render(panel).at(-1)).toContain('later lines');

    panel.upsert('tc-2', 'fresh update');
    const lines = render(panel);
    expect(lines.at(-1)).toContain('◆ fresh update');
    expect(lines.join('\n')).not.toContain('later lines');
  });

  it('dims the title and notes the ended turn, and clears wholesale', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert('tc-1', 'done with phase one');
    panel.setEnded(true);
    expect(render(panel)[1]).toContain('◇ Update · turn ended · next message clears');
    expect(render(panel)[2]).toContain('◆ done with phase one');

    panel.clear();
    expect(panel.isEmpty()).toBe(true);
    expect(panel.render(80)).toEqual([]);

    panel.upsert('tc-2', 'fresh turn');
    expect(render(panel)[1]).toContain('◆ Update');
    expect(render(panel)[1]).not.toContain('turn ended');
  });

  it('removes one entry and snaps the view back to the tail', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert('tc-1', 'first update');
    panel.upsert('tc-2', 'denied update');
    panel.upsert('tc-3', 'third update');

    expect(panel.remove('tc-2')).toBe(true);
    expect(panel.remove('tc-2')).toBe(false);
    expect(panel.getEntries().map((entry) => entry.id)).toEqual(['tc-1', 'tc-3']);
    expect(render(panel)[1]).toContain('Updates (2)');
    expect(body(panel).join('\n')).not.toContain('denied update');

    panel.remove('tc-1');
    panel.remove('tc-3');
    expect(panel.isEmpty()).toBe(true);
    expect(panel.render(80)).toEqual([]);
  });

  it('never renders wider than the requested width', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert('tc-1', `${'word '.repeat(60)}\n\n- a very long bullet ${'x'.repeat(120)}`);
    panel.upsert('tc-2', listRows(12, 'later'));
    for (const width of [24, 40, 80]) {
      for (const line of panel.render(width)) {
        expect(strip(line).length).toBeLessThanOrEqual(width);
      }
    }
  });
});
