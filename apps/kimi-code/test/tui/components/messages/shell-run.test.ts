import { renderComponentLines, TuiAltScreen } from '@moonshot-ai/pi-tui';
import { afterEach, describe, expect, it } from 'vitest';

import { ShellRunComponent } from '#/tui/components/messages/shell-run';
import { flattenTranscriptRow } from '#/tui/components/messages/transcript-row-layout';

import { VirtualTerminal } from '../../../../../../packages/pi-tui/test/virtual-terminal';

function stripTheme(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

async function expectLogicalLineCopy(component: ShellRunComponent, source: string): Promise<void> {
  const terminal = new VirtualTerminal(12, 20);
  const copied: string[] = [];
  const tui = new TuiAltScreen(terminal, undefined, undefined, {
    copySelection: async (text) => {
      copied.push(text);
      return true;
    },
  });
  tui.addChild(component);
  tui.start();
  try {
    await terminal.waitForRender();
    const rows = tui.getScreenLines().map(stripTheme);
    const firstNeedle = source.slice(0, 4);
    const lastNeedle = source.slice(-4);
    const startRow = rows.findIndex((line) => line.includes(firstNeedle));
    const endRow = rows.findLastIndex((line) => line.includes(lastNeedle));
    expect(startRow).toBeGreaterThanOrEqual(0);
    expect(endRow).toBeGreaterThanOrEqual(startRow);
    const startColumn = rows[startRow]!.indexOf(firstNeedle) + 1;
    const endColumn = rows[endRow]!.indexOf(lastNeedle) + lastNeedle.length;
    terminal.sendInput(`\u001B[<0;${startColumn};${startRow + 1}M`);
    terminal.sendInput(`\u001B[<32;${endColumn};${endRow + 1}M`);
    terminal.sendInput(`\u001B[<0;${endColumn};${endRow + 1}m`);
    await terminal.waitForRender();
    expect(copied).toEqual([source]);
  } finally {
    tui.stop();
  }
}

describe('ShellRunComponent hardening', () => {
  let component: ShellRunComponent | undefined;

  afterEach(() => {
    component?.dispose();
    component = undefined;
  });

  function create(): ShellRunComponent {
    component = new ShellRunComponent(() => {});
    return component;
  }

  it('caps the running buffer and never throws on huge streaming output', () => {
    const c = create();
    const chunk = 'x'.repeat(50_000);
    expect(() => {
      for (let i = 0; i < 20; i++) c.append(chunk);
      c.render(100);
    }).not.toThrow();
  });

  it('finish switches to the final view and ignores later appends', () => {
    const c = create();
    c.finish('final output', '', false);
    c.append('should be ignored');
    const rendered = stripTheme(c.render(100).join('\n'));
    expect(rendered).toContain('final output');
    expect(rendered).not.toContain('should be ignored');
  });

  it('finishBackgrounded renders the background hint', () => {
    const c = create();
    c.finishBackgrounded();
    const rendered = stripTheme(c.render(100).join('\n'));
    expect(rendered).toContain('Moved to background.');
  });

  it('append / finish are no-ops after dispose', () => {
    const c = create();
    c.dispose();
    expect(() => {
      c.append('late');
      c.finish('late', '', false);
      c.finishBackgrounded();
      c.render(100);
    }).not.toThrow();
  });

  it('does not throw when the render callback throws', () => {
    const c = new ShellRunComponent(() => {
      throw new Error('render failed');
    });
    component = c;
    expect(() => {
      c.append('output');
      c.render(100);
    }).not.toThrow();
  });

  it('marks running, backgrounded, and finished indentation as decoration', () => {
    const c = create();
    c.append('output');
    const running = renderComponentLines(c, 20).find((line) => line.text.includes('output'));
    expect(running?.selectionExclusions).toEqual([{ start: 0, end: 2 }]);

    c.finishBackgrounded();
    const backgrounded = renderComponentLines(c, 20).filter(
      (line) => line.text.includes('Moved to') || line.text.includes('background.'),
    );
    expect(backgrounded).toHaveLength(2);
    for (const line of backgrounded) {
      expect(line.selectionExclusions).toEqual([{ start: 0, end: 2 }]);
    }

    const finished = create();
    finished.finish('output', '', false);
    const finalLine = renderComponentLines(finished, 20).find((line) => line.text.includes('output'));
    expect(finalLine?.selectionExclusions).toEqual([{ start: 0, end: 2 }]);
  });

  it.each([2, 4])('keeps running and finished indentation consistent at width %i', (width) => {
    const c = create();
    c.append('abcd');
    const running = c.render(width);
    c.finish('abcd', '', false);
    const finished = c.render(width);
    expect(finished).toEqual(running.slice(0, finished.length));
  });

  it('keeps an 18-cell body on one line at width 20 when running and finished', () => {
    const source = '123456789012345678';
    const c = create();
    c.append(source);
    const running = c.render(20);
    c.finish(source, '', false);
    const finished = c.render(20);
    expect(finished).toHaveLength(1);
    expect(finished[0]).toBe(running[0]);
  });

  it('copies long running and finished output without visual newlines or indentation', async () => {
    const source = '1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const c = create();
    c.append(source);
    await expectLogicalLineCopy(c, source);
    c.finish(source, '', false);
    await expectLogicalLineCopy(c, source);
  });

  it('separates indentation from streaming and finalized transcript content', () => {
    const c = create();
    c.append('first');
    const running = c.renderTranscriptRow(20);
    expect(c.renderTranscriptRow(20)).toBe(running);
    expect(running.gutterWidth).toBe(2);
    const runningContent = running.contentLines.map((line) => stripTheme(line.text).trimEnd());
    expect(runningContent[0]).toBe('first');
    expect(runningContent[1]).toMatch(/^\(\d+s\)$/);
    expect(runningContent.slice(2).join(' ')).toBe('(ctrl+b to run in background)');
    expect(running.gutterLines.every((line) => line.text === '  ')).toBe(true);

    c.append('\nsecond');
    const updated = c.renderTranscriptRow(20);
    expect(updated).not.toBe(running);
    expect(updated.contentLines.map((line) => line.text).join('\n')).toContain('second');

    c.finish('first\nsecond', '', false);
    const finished = c.renderTranscriptRow(20);
    expect(finished.contentLines.map((line) => stripTheme(line.text).trimEnd())).toEqual([
      'first',
      'second',
    ]);
    expect(finished.gutterLines.every((line) => line.text === '  ')).toBe(true);
    expect(flattenTranscriptRow(finished, 20).map((line) => line.selectionRegion)).toEqual([
      { content: finished.contentLines[0], column: 2, width: 18 },
      { content: finished.contentLines[1], column: 2, width: 18 },
    ]);

    c.invalidate();
    const invalidated = c.renderTranscriptRow(20);
    expect(invalidated.contentLines.map((line) => line.text)).toEqual(
      finished.contentLines.map((line) => line.text),
    );
  });
});

describe('ShellRunComponent finished collapse', () => {
  let component: ShellRunComponent | undefined;

  afterEach(() => {
    component?.dispose();
    component = undefined;
  });

  function create(): ShellRunComponent {
    component = new ShellRunComponent(() => {});
    return component;
  }

  function rows(n: number): string {
    return Array.from({ length: n }, (_, i) => `row-${String(i + 1).padStart(2, '0')}`).join('\n');
  }

  it('collapses finished output to the first 10 visual rows with an expand hint', () => {
    const c = create();
    c.finish(rows(30), '', false);
    const rendered = stripTheme(c.render(80).join('\n'));
    expect(rendered).toContain('… (20 more lines, ctrl+o to expand)');
    expect(rendered).toContain('row-01');
    expect(rendered).toContain('row-10');
    expect(rendered).not.toContain('row-11');
  });

  it('renders short finished output in full without a hint', () => {
    const c = create();
    c.finish(rows(10), '', false);
    const rendered = stripTheme(c.render(80).join('\n'));
    expect(rendered).toContain('row-01');
    expect(rendered).toContain('row-10');
    expect(rendered).not.toContain('more lines');
  });

  it('setExpanded toggles the finished view', () => {
    const c = create();
    c.finish(rows(30), '', false);

    c.setExpanded(true);
    const expanded = stripTheme(c.render(80).join('\n'));
    expect(expanded).toContain('row-30');
    expect(expanded).not.toContain('more lines');

    c.setExpanded(false);
    const collapsed = stripTheme(c.render(80).join('\n'));
    expect(collapsed).toContain('… (20 more lines, ctrl+o to expand)');
    expect(collapsed).not.toContain('row-11');
  });

  it('expands the running view via setExpanded', () => {
    const c = create();
    c.append(rows(10));

    c.setExpanded(true);
    const expanded = stripTheme(c.render(80).join('\n'));
    expect(expanded).toContain('row-01');
    expect(expanded).toContain('row-10');
    expect(expanded).toContain('(ctrl+b to run in background)');
    expect(expanded).not.toContain('+5 lines');

    c.setExpanded(false);
    const collapsed = stripTheme(c.render(80).join('\n'));
    expect(collapsed).toContain('+5 lines');
    expect(collapsed).not.toContain('row-01');
  });

  it('refreshes separated transcript rows when finished output expands', () => {
    const c = create();
    c.finish(rows(30), '', false);
    const collapsed = c.renderTranscriptRow(80);
    expect(collapsed.contentLines.map((line) => line.text).join('\n')).toContain('ctrl+o to expand');

    c.setExpanded(true);
    const expanded = c.renderTranscriptRow(80);
    expect(expanded).not.toBe(collapsed);
    expect(expanded.contentLines.map((line) => line.text).join('\n')).toContain('row-30');
    expect(expanded.contentLines.map((line) => line.text).join('\n')).not.toContain('ctrl+o to expand');
  });

  it('carries the expanded state over to the finished view', () => {
    const c = create();
    c.append(rows(10));
    c.setExpanded(true);

    c.finish(rows(30), '', false);
    const finished = stripTheme(c.render(80).join('\n'));
    expect(finished).toContain('row-30');
    expect(finished).not.toContain('more lines');
  });

  it('flags a truncated buffer in the expanded running view', () => {
    const c = create();
    c.append('x'.repeat(300 * 1024));
    c.setExpanded(true);
    const rendered = stripTheme(c.render(80).join('\n'));
    expect(rendered).toContain('… (output truncated)');
  });

  it('keeps the backgrounded view when toggled', () => {
    const c = create();
    c.finishBackgrounded();
    c.setExpanded(true);
    const rendered = stripTheme(c.render(80).join('\n'));
    expect(rendered).toContain('Moved to background.');
  });

  it('collapses failed output the same way instead of auto-expanding', () => {
    const c = create();
    c.finish(rows(30), 'boom', true);
    const collapsed = stripTheme(c.render(80).join('\n'));
    expect(collapsed).toContain('… (21 more lines, ctrl+o to expand)');

    c.setExpanded(true);
    const expanded = stripTheme(c.render(80).join('\n'));
    expect(expanded).toContain('boom');
  });
});

describe('ShellRunComponent hasHiddenContent', () => {
  let component: ShellRunComponent | undefined;

  afterEach(() => {
    component?.dispose();
    component = undefined;
  });

  function create(): ShellRunComponent {
    component = new ShellRunComponent(() => {});
    return component;
  }

  it('reports hidden rows while the running tail leaves earlier output behind', () => {
    const c = create();
    c.append('one\ntwo\nthree\n');
    expect(c.hasHiddenContent()).toBe(false);
    c.append('four\nfive\nsix\nseven\n');
    expect(c.hasHiddenContent()).toBe(true);
  });

  it('follows the finished preview cap after a collapsed render', () => {
    const c = create();
    c.finish(Array.from({ length: 20 }, (_, i) => `row ${String(i + 1)}`).join('\n'), '', false);
    c.render(100);
    expect(c.hasHiddenContent()).toBe(true);

    const short = create();
    short.finish('done', '', false);
    short.render(100);
    expect(short.hasHiddenContent()).toBe(false);
  });

  it('does not advertise ctrl+o when only one row would hide', () => {
    const c = create();
    c.finish(Array.from({ length: 11 }, (_, i) => `row ${String(i + 1)}`).join('\n'), '', false);
    c.render(100);
    expect(c.hasHiddenContent()).toBe(false);

    const foldable = create();
    foldable.finish(Array.from({ length: 12 }, (_, i) => `row ${String(i + 1)}`).join('\n'), '', false);
    foldable.render(100);
    expect(foldable.hasHiddenContent()).toBe(true);
  });
});

describe('ShellRunComponent hasHiddenContent when finished while expanded', () => {
  let component: ShellRunComponent | undefined;

  afterEach(() => {
    component?.dispose();
    component = undefined;
  });

  it('still reports the rows a collapse would hide, without a prior collapsed render', () => {
    component = new ShellRunComponent(() => {});
    component.setExpanded(true);
    component.finish(Array.from({ length: 20 }, (_, i) => `row ${String(i + 1)}`).join('\n'), '', false);
    component.render(100);
    expect(component.hasHiddenContent()).toBe(true);
  });
});
