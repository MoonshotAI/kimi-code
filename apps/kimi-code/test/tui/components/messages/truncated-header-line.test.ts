import { visibleWidth } from '@moonshot-ai/pi-tui';
import { describe, expect, it } from 'vitest';

import {
  renderHeaderContent,
  TruncatedHeaderLine,
  type HeaderSegments,
} from '#/tui/components/messages/truncated-header-line';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

const upper = (text: string): string => text.toUpperCase();

function segments(text: string, keep: 'head' | 'tail', tail = ' · 3 lines'): HeaderSegments {
  return { head: '● Ran a command · $ ', flex: { text, keep }, tail };
}

describe('renderHeaderContent', () => {
  it('truncates a plain string at the width', () => {
    expect(strip(renderHeaderContent('short', 40))).toBe('short');
    const cut = strip(renderHeaderContent('x'.repeat(50), 20));
    expect(visibleWidth(cut)).toBeLessThanOrEqual(20);
    expect(cut.endsWith('…')).toBe(true);
  });

  it('lets the middle fill the row and keeps the tail when it fits', () => {
    const line = strip(renderHeaderContent(segments('git status --short', 'head'), 80));
    expect(line).toBe('● Ran a command · $ git status --short · 3 lines');
  });

  it('cuts the middle from its end and still shows the tail on a narrow row', () => {
    const command =
      'git log --oneline -5 origin/main -- apps/kimi-code/test/tui/kimi-tui-message-flow.test.ts';
    const line = strip(renderHeaderContent(segments(command, 'head'), 60));
    expect(visibleWidth(line)).toBeLessThanOrEqual(60);
    expect(line.startsWith('● Ran a command · $ git log')).toBe(true);
    expect(line.endsWith('… · 3 lines')).toBe(true);
  });

  it('keeps the end of a path-like middle behind a leading ellipsis', () => {
    const path =
      '/Users/someone/.kimi-code/sessions/session_5b2c/agents/main/tasks/bash-4g77gs5f/output.log';
    const line = strip(
      renderHeaderContent(
        { head: '● Used Read (', flex: { text: path, keep: 'tail' }, tail: ') · 8 lines' },
        60,
      ),
    );
    expect(visibleWidth(line)).toBeLessThanOrEqual(60);
    expect(line).toContain('(…');
    expect(line.endsWith('/output.log) · 8 lines')).toBe(true);
  });

  it('measures wide characters by cells, not by code units', () => {
    const line = strip(
      renderHeaderContent(segments('运行全部测试并生成覆盖率报告然后上传', 'head', ''), 30),
    );
    expect(visibleWidth(line)).toBeLessThanOrEqual(30);
    expect(line.endsWith('…')).toBe(true);
  });

  it('styles the middle after the cut so the ellipsis is styled too', () => {
    const line = renderHeaderContent(
      { head: 'H ', flex: { text: 'abcdefghij', keep: 'head', style: upper }, tail: ' T' },
      10,
    );
    expect(line).toBe('H ABCDE… T');
  });

  it('drops the middle before the fixed parts when the row is too narrow for it', () => {
    const content = { head: 'HEAD ', flex: { text: 'abcdef', keep: 'head' as const }, tail: ' T' };
    // One spare cell: the middle collapses to an ellipsis between the fixed parts.
    expect(renderHeaderContent(content, 8)).toBe('HEAD … T');
    // No spare cell: the middle is dropped outright, both fixed parts stay.
    expect(renderHeaderContent(content, 7)).toBe('HEAD  T');
  });

  it('cuts the head from its end so the tail survives when even the fixed parts overflow', () => {
    const content = { head: 'HEAD ', flex: { text: 'abcdef', keep: 'head' as const }, tail: ' T' };
    const line = strip(renderHeaderContent(content, 5));
    expect(line).toBe('HE… T');
    // Below two cells for the head there is nothing left to keep: cut from the end.
    const tiny = strip(renderHeaderContent(content, 3));
    expect(visibleWidth(tiny)).toBeLessThanOrEqual(3);
    expect(tiny.endsWith('…')).toBe(true);
  });

  it('keeps ANSI escape sequences atomic and zero-width when cutting', () => {
    const colored = '\x1b[32mabcdef\x1b[0mghijkl';
    // 2 (head) + 5 for the middle: the whole opening sequence plus 4 visible
    // cells, then the ellipsis. The sequence is never split or measured.
    const line = renderHeaderContent(
      { head: 'H ', flex: { text: colored, keep: 'head' }, tail: '' },
      7,
    );
    expect(line).toBe('H \x1b[32mabcd…');
    expect(visibleWidth(line)).toBeLessThanOrEqual(7);
  });

  it('cuts a huge argument without walking it whole', () => {
    const huge = `prefix-${'x'.repeat(200_000)}-suffix`;
    const head = strip(renderHeaderContent(segments(huge, 'head', ''), 40));
    expect(head.startsWith('● Ran a command · $ prefix-xxx')).toBe(true);
    expect(head.endsWith('…')).toBe(true);
    expect(visibleWidth(head)).toBeLessThanOrEqual(40);

    const tail = strip(renderHeaderContent(segments(huge, 'tail', ''), 40));
    expect(tail).toContain('$ …');
    expect(tail.endsWith('-suffix')).toBe(true);
    expect(visibleWidth(tail)).toBeLessThanOrEqual(40);
  });
});

describe('TruncatedHeaderLine', () => {
  it('reuses its rendered array across structurally equal headers', () => {
    const line = new TruncatedHeaderLine(segments('ls', 'head'));
    const first = line.render(80);
    line.setText(segments('ls', 'head'));
    expect(line.render(80)).toBe(first);
    line.setText(segments('ls -la', 'head'));
    expect(line.render(80)).not.toBe(first);
  });

  it('reports whether the last render cut the row', () => {
    const command =
      'git log --oneline -5 origin/main -- apps/kimi-code/test/tui/kimi-tui-message-flow.test.ts';
    const line = new TruncatedHeaderLine(segments(command, 'head'));
    expect(line.wasTruncated()).toBe(false);
    line.render(160);
    expect(line.wasTruncated()).toBe(false);
    line.render(60);
    expect(line.wasTruncated()).toBe(true);
    line.render(160);
    expect(line.wasTruncated()).toBe(false);
  });
});

describe('graphemes that pack many code units into a cell', () => {
  // A ZWJ family emoji: 2 cells, 11 UTF-16 code units.
  const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}';

  it('never assumes a cut from code-unit length alone', () => {
    const text = family.repeat(10);
    expect(visibleWidth(text)).toBe(20);
    const line = renderHeaderContent({ head: '', flex: { text, keep: 'head' }, tail: '' }, 20);
    expect(line).toBe(text);
    const tailKept = renderHeaderContent({ head: '', flex: { text, keep: 'tail' }, tail: '' }, 20);
    expect(tailKept).toBe(text);
  });

  it('keeps whole emoji clusters at the tail when it does have to cut', () => {
    const text = `${'x'.repeat(30)}${family.repeat(5)}`;
    const line = renderHeaderContent({ head: '', flex: { text, keep: 'tail' }, tail: '' }, 9);
    expect(line).toBe(`…${family.repeat(4)}`);
    expect(visibleWidth(line)).toBe(9);
  });
});
