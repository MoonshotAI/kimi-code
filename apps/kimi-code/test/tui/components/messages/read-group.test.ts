import { visibleWidth } from '@moonshot-ai/pi-tui';
import { describe, expect, it } from 'vitest';

import { ReadGroupComponent } from '#/tui/components/messages/read-group';
import { ToolCallComponent } from '#/tui/components/messages/tool-call';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function readCall(id: string, path: string, lines: number): ToolCallComponent {
  return new ToolCallComponent(
    { id, name: 'Read', args: { path } },
    {
      tool_call_id: id,
      output: Array.from({ length: lines }, (_, i) => `${String(i + 1)}\tline`).join('\n'),
      is_error: false,
    },
  );
}

function makeGroup(): ReadGroupComponent {
  const group = new ReadGroupComponent(undefined);
  group.attach('r1', readCall('r1', 'src/very/deeply/nested/directory/alpha-component.ts', 120));
  group.attach('r2', readCall('r2', 'src/very/deeply/nested/directory/beta-component.ts', 80));
  return group;
}

function rows(group: ReadGroupComponent, width: number): string[] {
  return group.render(width).map(strip).filter((line) => line.trim().length > 0);
}

describe('ReadGroupComponent', () => {
  it('collapses to a single header row and hides the per-file body until expanded', () => {
    const group = makeGroup();

    const collapsed = rows(group, 100);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]).toContain('Read 2 files · 200 lines');
    expect(collapsed[0]).not.toContain('alpha-component.ts');

    group.setExpanded(true);
    const expanded = rows(group, 100);
    expect(expanded[0]).toContain('Read 2 files · 200 lines');
    expect(expanded.join('\n')).toContain('alpha-component.ts · 120 lines');
    expect(expanded.join('\n')).toContain('beta-component.ts · 80 lines');

    group.setExpanded(false);
    expect(rows(group, 100)).toHaveLength(1);
  });

  it('truncates the header to the terminal width instead of wrapping', () => {
    const group = makeGroup();
    for (const width of [16, 24]) {
      const collapsed = rows(group, width);
      expect(collapsed).toHaveLength(1);
      expect(visibleWidth(collapsed[0]!)).toBeLessThanOrEqual(width);
      expect(collapsed[0]).toContain('…');
    }
  });
});

describe('ReadGroupComponent hasHiddenContent', () => {
  it('is true once a Read is attached, since the file bodies only render expanded', () => {
    expect(new ReadGroupComponent(undefined).hasHiddenContent()).toBe(false);
    expect(makeGroup().hasHiddenContent()).toBe(true);
  });
});

describe('ReadGroupComponent header on a narrow terminal', () => {
  function failedRead(id: string, path: string): ToolCallComponent {
    return new ToolCallComponent(
      { id, name: 'Read', args: { path } },
      { tool_call_id: id, output: 'ENOENT: no such file or directory', is_error: true },
    );
  }

  it('keeps the failure count visible when the row is cut', () => {
    const group = new ReadGroupComponent(undefined);
    group.attach('ok', readCall('ok', 'src/very/deeply/nested/directory/alpha-component.ts', 120));
    group.attach('bad', failedRead('bad', 'src/very/deeply/nested/directory/missing.ts'));

    const wide = rows(group, 120);
    expect(wide[0]).toContain('Read 2 files · 120 lines · 1 failed');

    const narrow = rows(group, 26);
    expect(visibleWidth(narrow[0]!)).toBeLessThanOrEqual(26);
    expect(narrow[0]!.endsWith('1 failed')).toBe(true);
    expect(narrow[0]).not.toContain('lines');
  });
});
