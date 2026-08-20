import { afterEach, describe, expect, it } from 'vitest';

import { ShellRunComponent } from '#/tui/components/messages/shell-run';

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
    expect(rendered).toContain('... (20 more lines, ctrl+o to expand)');
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
    expect(collapsed).toContain('... (20 more lines, ctrl+o to expand)');
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
    expect(rendered).toContain('... (output truncated)');
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
    expect(collapsed).toContain('... (21 more lines, ctrl+o to expand)');

    c.setExpanded(true);
    const expanded = stripTheme(c.render(80).join('\n'));
    expect(expanded).toContain('boom');
  });
});
