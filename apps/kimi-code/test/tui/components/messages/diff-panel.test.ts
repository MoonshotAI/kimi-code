import { visibleWidth } from '@moonshot-ai/pi-tui';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildDiffPanelLines,
  DiffPanelComponent,
} from '#/tui/components/messages/diff-panel';
import { currentTheme, darkColors, lightColors } from '#/tui/theme';

afterEach(() => {
  currentTheme.setPalette(darkColors);
});

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

const SAMPLE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index 1234567..abcdefg 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,3 @@
 export function foo() {
-  return 1;
+  return 2;
 }
\\ No newline at end of file`;

describe('buildDiffPanelLines', () => {
  it('returns "No changes." for empty output', () => {
    const lines = buildDiffPanelLines('');
    expect(lines).toHaveLength(1);
    expect(strip(lines[0] ?? '')).toBe('No changes.');
  });

  it('returns "No changes." for whitespace-only output', () => {
    const lines = buildDiffPanelLines('   \n\n  ');
    expect(strip(lines[0] ?? '')).toBe('No changes.');
  });

  it('colorizes diff headers as meta', () => {
    const lines = buildDiffPanelLines(SAMPLE_DIFF);
    const stripped = lines.map(strip);
    expect(stripped[0]).toBe('diff --git a/src/foo.ts b/src/foo.ts');
    expect(stripped[1]).toBe('index 1234567..abcdefg 100644');
    expect(stripped[2]).toBe('--- a/src/foo.ts');
    expect(stripped[3]).toBe('+++ b/src/foo.ts');
  });

  it('colorizes hunk headers as gutter', () => {
    const lines = buildDiffPanelLines(SAMPLE_DIFF);
    expect(strip(lines[4] ?? '')).toBe('@@ -1,3 +1,3 @@');
  });

  it('colorizes added and removed lines', () => {
    const lines = buildDiffPanelLines(SAMPLE_DIFF);
    const stripped = lines.map(strip);
    expect(stripped).toContain('-  return 1;');
    expect(stripped).toContain('+  return 2;');
  });

  it('leaves context lines uncolored', () => {
    const lines = buildDiffPanelLines(SAMPLE_DIFF);
    const stripped = lines.map(strip);
    expect(stripped).toContain(' export function foo() {');
    expect(stripped).toContain(' }');
  });

  it('colorizes "No newline at end of file" as meta', () => {
    const lines = buildDiffPanelLines(SAMPLE_DIFF);
    expect(strip(lines.at(-1) ?? '')).toBe('\\ No newline at end of file');
  });
});

describe('DiffPanelComponent', () => {
  it('wraps diff lines in a bordered panel', () => {
    const component = new DiffPanelComponent(() => buildDiffPanelLines(SAMPLE_DIFF));
    const output = component.render(80).map(strip);

    expect(output[0]).toContain(' Diff ');
    expect(output.some((line) => line.includes('diff --git a/src/foo.ts b/src/foo.ts'))).toBe(true);
  });

  it('truncates lines wider than the terminal so the panel never overflows', () => {
    const longLine = '+' + 'x'.repeat(200);
    const component = new DiffPanelComponent(() => [longLine]);
    const width = 60;

    const output = component.render(width);
    for (const line of output) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it('keeps the bordered panel within narrow terminal widths', () => {
    const component = new DiffPanelComponent(() => buildDiffPanelLines(SAMPLE_DIFF));

    for (const width of [39, 24, 20, 10, 4, 1]) {
      for (const line of component.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('rebuilds its body from the active palette on invalidate', () => {
    const component = new DiffPanelComponent(() => [
      `color=${currentTheme.color('diffAdded')}`,
    ]);
    const bodyOf = (): string => {
      const line = component.render(80).map(strip).find((l) => l.includes('color='));
      if (line === undefined) throw new Error('body line not found');
      return line;
    };

    expect(bodyOf()).toContain(darkColors.diffAdded);
    currentTheme.setPalette(lightColors);
    component.invalidate();
    expect(bodyOf()).toContain(lightColors.diffAdded);
  });
});
