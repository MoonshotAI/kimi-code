import { visibleWidth } from '@moonshot-ai/pi-tui';
import { describe, expect, it } from 'vitest';

import { NotifyPanelComponent, type NotifyEntry } from '#/tui/components/chrome/notify-panel';
import { NOTIFY_PANEL_PAGE_LINES } from '#/tui/constant/rendering';

function entry(id: string, text: string, agentId = 'main'): NotifyEntry {
  return { id, text, agentId, time: Number(id) || 1 };
}
function render(panel: NotifyPanelComponent, width = 100): string[] {
  return panel.render(width).map((line) => line.replaceAll(/\u001B\[[0-9;]*m/g, '').trimEnd());
}
function listRows(count: number): string {
  return Array.from({ length: count }, (_, i) => `- row ${i + 1}`).join('\n');
}

describe('NotifyPanelComponent', () => {
  it('is empty until an update arrives and does not reserve paging keys for a single page', () => {
    const panel = new NotifyPanelComponent();
    expect(panel.render(80)).toEqual([]);
    expect(panel.changePage(-1)).toBe(false);
    panel.upsert(entry('1', 'An update.'));
    expect(render(panel)[0]).toContain('1/1');
    expect(panel.changePage(-1)).toBe(false);
    expect(panel.changePage(1)).toBe(false);
  });

  it('retains all updates from the same source with inline labels and full markdown', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('1', 'First **main** update.'));
    panel.upsert(entry('2', 'First child update.', 'agent-7'));
    panel.upsert(entry('3', 'Second main update.'));
    panel.upsert(entry('4', 'Second child update.', 'agent-7'));
    const lines = render(panel);
    expect(lines.slice(1)).toEqual([
      '  First main update.',
      '  [agent-7] First child update.',
      '  Second main update.',
      '  [agent-7] Second child update.',
    ]);
    expect(panel.getEntries()).toHaveLength(4);
    expect(lines.join('\n')).not.toMatch(/\d{2}:\d{2}/);
  });

  it('pages backwards and forwards in eight-row pages without wrapping', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('1', listRows(17)));
    expect(render(panel)[0]).toContain('3/3');
    expect(render(panel)).toHaveLength(NOTIFY_PANEL_PAGE_LINES + 1);
    expect(panel.changePage(-1)).toBe(true);
    expect(render(panel)[0]).toContain('2/3');
    expect(render(panel)[1]).toContain('row 2');
    expect(render(panel)[8]).toContain('row 9');
    panel.changePage(-1);
    const first = render(panel);
    expect(first[0]).toContain('1/3');
    expect(first[1]).toContain('row 1');
    expect(first).toHaveLength(2);
    expect(panel.changePage(-1)).toBe(true);
    expect(render(panel)).toEqual(first);
    panel.changePage(1);
    expect(render(panel)[0]).toContain('2/3');
    panel.changePage(1);
    const last = render(panel);
    expect(last[1]).toContain('row 10');
    expect(last[8]).toContain('row 17');
    expect(panel.changePage(1)).toBe(true);
    expect(render(panel)).toEqual(last);
  });

  it.each([1, 2, 8, 9, 10, 16, 17, 18, 24])(
    'packs %i one-line updates from the end without padding, overlap or omissions',
    (count) => {
      const panel = new NotifyPanelComponent();
      const messages = Array.from({ length: count }, (_, i) => `update ${i + 1}`);
      for (const [i, message] of messages.entries()) panel.upsert(entry(String(i), message));
      const pages = Math.ceil(count / NOTIFY_PANEL_PAGE_LINES);
      expect(render(panel).slice(1)).toEqual(
        messages.slice(-NOTIFY_PANEL_PAGE_LINES).map((message) => `  ${message}`),
      );
      for (let i = 1; i < pages; i++) panel.changePage(-1);
      expect(render(panel)).toHaveLength(((count - 1) % NOTIFY_PANEL_PAGE_LINES) + 2);
      const all: string[] = [];
      for (let i = 0; i < pages; i++) {
        all.push(
          ...render(panel)
            .slice(1)
            .map((line) => line.trim()),
        );
        panel.changePage(1);
      }
      expect(all).toEqual(messages);
    },
  );

  it('preserves the selected page while new updates arrive, and follows the last page', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('1', listRows(16)));
    render(panel);
    panel.changePage(-1);
    const first = render(panel).slice(1);
    panel.upsert(entry('2', 'New update'));
    panel.upsert(entry('2', 'New update continued'));
    expect(render(panel).slice(1)).toEqual(first);
    expect(render(panel)[0]).toContain('1/3');
    expect(render(panel)[0]).toContain('1 new update');
    panel.changePage(1);
    expect(render(panel)[1]).toContain('row 9');
    expect(render(panel)[8]).toContain('row 16');
    panel.changePage(1);
    expect(render(panel)[0]).not.toContain('new update');
    expect(render(panel)[8]).toContain('New update continued');
    panel.upsert(entry('3', listRows(10)));
    expect(render(panel)[0]).toContain('4/4');
    expect(render(panel).join('\n')).toContain('row 10');
  });

  it('keeps the source visible on a continuation page without dropping message rows', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('1', listRows(17), 'agent-7'));
    expect(render(panel)[1]).toContain('[agent-7]');
    expect(render(panel)[1]).toContain('row 10');
    panel.changePage(-1);
    expect(render(panel)[1]).toContain('[agent-7]');
    expect(render(panel)[1]).toContain('row 2');
  });

  it('keeps a short first page steady when many new rows arrive', () => {
    const panel = new NotifyPanelComponent();
    for (let i = 1; i <= 10; i++) panel.upsert(entry(String(i), `update ${i}`));
    render(panel);
    panel.changePage(-1);
    const first = render(panel).slice(1);
    expect(first).toEqual(['  update 1', '  update 2']);
    for (let i = 11; i <= 29; i++) panel.upsert(entry(String(i), `update ${i}`));
    expect(render(panel).slice(1)).toEqual(first);
    expect(render(panel)[0]).toContain('19 new updates');
    const seen = new Set(first.map((line) => line.trim()));
    for (let i = 0; i < 4; i++) {
      panel.changePage(1);
      for (const line of render(panel).slice(1)) seen.add(line.trim());
    }
    expect([...seen]).toEqual(Array.from({ length: 29 }, (_, i) => `update ${i + 1}`));
    expect(render(panel)[0]).not.toContain('new updates');
    expect(render(panel).slice(1)).toEqual(
      Array.from({ length: 8 }, (_, i) => `  update ${i + 22}`),
    );
  });

  it('keeps the resized page steady when another update arrives', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('1', 'word '.repeat(240)));
    render(panel, 100);
    expect(panel.changePage(-1)).toBe(true);
    const resized = render(panel, 40).slice(1);
    panel.upsert(entry('2', 'Another update'));
    expect(render(panel, 40).slice(1)).toEqual(resized);
  });

  it('does not impose the former 100-entry or 16K message limits', () => {
    const panel = new NotifyPanelComponent();
    for (let i = 0; i < 150; i++) panel.upsert(entry(String(i), `update ${i}`));
    expect(panel.getEntries()).toHaveLength(150);
    expect(panel.getEntries()[0]!.text).toBe('update 0');
    const long = `${'word '.repeat(4000)}COMPLETE_END`;
    panel.upsert(entry('long', long));
    expect(panel.getEntries().at(-1)!.text).toBe(long);
    expect(render(panel).join('\n')).toContain('COMPLETE_END');
  });

  it('updates streaming entries in place and removes only failed calls', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('1', 'Reading'));
    panel.upsert(entry('2', 'Another update'));
    panel.upsert(entry('1', 'Reading the parser'));
    expect(panel.getEntries().map((item) => item.text)).toEqual([
      'Reading the parser',
      'Another update',
    ]);
    expect(panel.remove('1')).toBe(true);
    expect(panel.remove('1')).toBe(false);
    expect(render(panel)[1]).toContain('Another update');
    panel.clear();
    expect(panel.render(100)).toEqual([]);
    expect(panel.changePage(-1)).toBe(false);
  });

  it('updates pagination after entries are removed or the terminal is resized', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('1', listRows(8)));
    panel.upsert(entry('2', listRows(8)));
    render(panel);
    panel.changePage(-1);
    panel.remove('2');
    expect(render(panel)[0]).toContain('1/1');
    panel.upsert(entry('3', 'word '.repeat(50)));
    expect(render(panel, 24)[0]).not.toContain('1/1');
    expect(panel.changePage(-1)).toBe(true);
  });

  it('uses complete agent ids and fits narrow terminals', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('1', 'first finding', 'agent-7'));
    panel.upsert(entry('2', 'second finding', 'agent-29'));
    for (const width of [28, 100, 300]) {
      expect(render(panel, width)[1]).toBe('  [agent-7] first finding');
      expect(render(panel, width)[2]).toBe('  [agent-29] second finding');
    }
    panel.upsert(entry('3', '检查中文消息。'.repeat(25), 'agent-105'));
    for (const width of [1, 4, 24, 40, 80]) {
      for (const line of panel.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    expect(panel.render(0)).toEqual([]);
  });

  it('reuses the frame when no message, page or width changed', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('1', 'unchanged'));
    expect(panel.render(80)).toBe(panel.render(80));
  });
});
