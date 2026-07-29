/**
 * Scenario: foreground `!` shell output transitions from its live tail to the completed frame.
 * Responsibilities: keep rendering safe and bound the completed frame for high-line-count output.
 * Wiring: real ShellRunComponent and pi-tui Text rendering; only the render callback is inert.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/components/messages/shell-run.test.ts
 */
import chalk from 'chalk';
import { afterEach, describe, expect, it } from 'vitest';

import { ShellRunComponent } from '#/tui/components/messages/shell-run';
import { currentTheme, darkColors, lightColors } from '#/tui/theme';

function stripTheme(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('ShellRunComponent hardening', () => {
  let component: ShellRunComponent | undefined;

  afterEach(() => {
    // Always clear the 1s timer so it can't keep the test process alive or
    // fire requestRender after the test ends.
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

  it('keeps completed stdout and stderr bounded when both contain many short lines', () => {
    const c = create();

    c.finish(
      `${'x\n'.repeat(49_999)}final stdout\n`,
      `${'y\n'.repeat(49_999)}final stderr\n`,
      true,
    );
    const rendered = c.render(120);
    const text = stripTheme(rendered.join('\n'));

    expect(rendered.length).toBeLessThanOrEqual(12);
    expect(rendered.join('\n').length).toBeLessThanOrEqual(2_048);
    expect(text.match(/\.\.\. \(49995 earlier lines\)/g)).toHaveLength(2);
    expect(text).toContain('final stdout');
    expect(text).toContain('final stderr');
  });

  it('caps a completed frame when output is one very long line', () => {
    const c = create();

    c.finish(`${'x'.repeat(200_000)}final`, '', false);
    const rendered = c.render(120);
    const text = stripTheme(rendered.join('\n'));

    expect(rendered.length).toBeLessThanOrEqual(560);
    expect(rendered.join('\n').length).toBeLessThanOrEqual(70_000);
    expect(text).toContain('... (earlier output truncated)');
    expect(text).toContain('final');
  });

  it('recolors completed output when the active theme changes', () => {
    const c = create();
    const previousPalette = currentTheme.palette;
    const previousLevel = chalk.level;
    try {
      chalk.level = 3;
      currentTheme.setPalette(darkColors);
      c.finish('final output', '', false);
      const dark = c.render(100).join('\n');

      currentTheme.setPalette(lightColors);
      c.invalidate();
      const light = c.render(100).join('\n');

      expect(light).not.toBe(dark);
      expect(light).toContain(currentTheme.fg('textDim', 'final output'));
    } finally {
      currentTheme.setPalette(previousPalette);
      chalk.level = previousLevel;
    }
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
});
