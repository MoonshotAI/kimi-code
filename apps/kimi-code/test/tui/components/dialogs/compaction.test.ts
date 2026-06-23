import chalk from 'chalk';
import { afterEach, describe, expect, it } from 'vitest';

import { CompactionComponent } from '#/tui/components/dialogs/compaction';
import { currentTheme, darkColors, lightColors } from '#/tui/theme';

afterEach(() => {
  currentTheme.setPalette(darkColors);
});

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('CompactionComponent', () => {
  it('renders the custom instruction below the compacting label', () => {
    const component = new CompactionComponent(undefined, 'keep the recent files only');

    try {
      const lines = component.render(120).map(strip);
      const text = lines.join('\n');

      expect(text).toContain('Compacting context...');
      expect(text).toContain('  keep the recent files only');
    } finally {
      component.dispose();
    }
  });

  it('renders a tip suffix while compacting', () => {
    const component = new CompactionComponent(undefined, undefined, 'ctrl+s: steer mid-turn');

    try {
      const lines = component.render(120).map(strip);
      const text = lines.join('\n');

      expect(text).toContain('Compacting context... · Tip: ctrl+s: steer mid-turn');
    } finally {
      component.dispose();
    }
  });

  it('does not render a tip after compaction completes', () => {
    const component = new CompactionComponent(undefined, undefined, 'ctrl+s: steer mid-turn');

    try {
      component.markDone(1000, 500);
      const lines = component.render(120).map(strip);
      const text = lines.join('\n');

      expect(text).toContain('Compaction complete');
      expect(text).not.toContain('Tip:');
    } finally {
      component.dispose();
    }
  });

  it('renders a cancelled terminal state', () => {
    const component = new CompactionComponent();

    try {
      component.markCanceled();
      const lines = component.render(120).map(strip);
      const text = lines.join('\n');

      expect(text).toContain('Compaction cancelled');
      expect(text).not.toContain('Compacting context...');
    } finally {
      component.dispose();
    }
  });

  it('repaints the header with the active palette on invalidate', () => {
    // Force truecolor so palette differences surface as ANSI codes even when
    // the test runner has no TTY.
    const previousLevel = chalk.level;
    chalk.level = 3;
    const component = new CompactionComponent();

    try {
      const headerOf = (): string => {
        const line = component.render(120).find((l) => strip(l).includes('Compacting context...'));
        if (line === undefined) throw new Error('header line not found');
        return line;
      };
      const before = headerOf();

      currentTheme.setPalette(lightColors);
      component.invalidate();
      const after = headerOf();

      // Same visible text, different ANSI colour codes.
      expect(strip(after)).toBe(strip(before));
      expect(after).not.toBe(before);
    } finally {
      chalk.level = previousLevel;
      component.dispose();
    }
  });
});
