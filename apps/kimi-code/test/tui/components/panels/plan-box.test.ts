import { pathToFileURL } from 'node:url';

import { visibleWidth } from '@moonshot-ai/pi-tui';
import { describe, expect, it } from 'vitest';

import { PlanBoxComponent } from '#/tui/components/messages/plan-box';
import { darkColors } from '#/tui/theme/colors';
import { createMarkdownTheme } from '#/tui/theme/pi-tui-theme';

const ESC = String.fromCodePoint(0x1b);
const BEL = String.fromCodePoint(0x07);

// Strip CSI styling and OSC 8 hyperlink sequences from rendered output so
// visible text can be matched directly.
function strip(text: string): string {
  return text
    .replaceAll(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '')
    .replaceAll(new RegExp(`${ESC}\\]8;;[^${BEL}]*${BEL}`, 'g'), '');
}

const theme = createMarkdownTheme();

describe('PlanBoxComponent', () => {
  it('falls back to bare " plan " title when no path is provided', () => {
    const box = new PlanBoxComponent('# Hello', theme, darkColors.success);
    const out = strip(box.render(60).join('\n'));
    const top = out.split('\n')[0]!;
    expect(top).toContain('┌ plan ');
    expect(top).not.toContain('plan:');
  });

  it('renders " plan: <basename> " in the top border without the directory prefix', () => {
    const box = new PlanBoxComponent(
      '# Hello',
      theme,
      darkColors.success,
      '/tmp/projects/foo/.kimi-code/plans/very-long-slug-name.md',
    );
    const out = strip(box.render(80).join('\n'));
    const top = out.split('\n')[0]!;
    expect(top).toContain(' plan: very-long-slug-name.md ');
    expect(top).not.toContain('/tmp/');
    expect(top).not.toContain('…/');
  });

  it('renders a status chip in the top border', () => {
    const box = new PlanBoxComponent('# Hello', theme, darkColors.success, undefined, {
      status: { label: 'Rejected', colorHex: darkColors.error },
    });
    const out = strip(box.render(60).join('\n'));
    const top = out.split('\n')[0]!;
    expect(top).toContain(' plan · Rejected ');
  });

  it('keeps path status title to the basename without leaking directories', () => {
    const box = new PlanBoxComponent(
      '# Hello',
      theme,
      darkColors.success,
      '/tmp/projects/foo/.kimi-code/plans/rejected-plan.md',
      {
        status: { label: 'Rejected', colorHex: darkColors.error },
      },
    );
    const out = strip(box.render(80).join('\n'));
    const top = out.split('\n')[0]!;
    expect(top).toContain(' plan: rejected-plan.md · Rejected ');
    expect(top).not.toContain('/tmp/');
    expect(top).not.toContain('…/');
  });

  it('wraps the basename in an OSC 8 hyperlink targeting file://', () => {
    const box = new PlanBoxComponent('# Hello', theme, darkColors.success, '/tmp/plan.md');
    const top = box.render(60)[0]!;
    expect(top).toContain(`${ESC}]8;;${pathToFileURL('/tmp/plan.md').href}${BEL}plan.md${ESC}]8;;${BEL}`);
    // After stripping OSC + CSI, visible width must respect the requested render width.
    expect(strip(top).length).toBeLessThanOrEqual(60);
  });

  it('skips the hyperlink for non-absolute paths but still shows the basename', () => {
    const box = new PlanBoxComponent('# Hello', theme, darkColors.success, 'relative/plan.md');
    const top = box.render(60)[0]!;
    expect(top).not.toContain(`${ESC}];`);
    expect(strip(top)).toContain(' plan: plan.md ');
  });

  it('degrades to bare " plan " when even the basename does not fit', () => {
    const box = new PlanBoxComponent('# Hello', theme, darkColors.success, '/tmp/plan.md');
    const out = strip(box.render(14).join('\n'));
    const top = out.split('\n')[0]!;
    expect(top).toContain(' plan ');
    expect(top).not.toContain('plan:');
  });

  it('keeps every line within narrow widths', () => {
    const box = new PlanBoxComponent(
      '# Hello\n\n' + 'step with a fairly long description '.repeat(4),
      theme,
      darkColors.success,
      '/tmp/projects/foo/.kimi-code/plans/very-long-slug-name.md',
    );

    for (const width of [39, 14, 10, 8, 4, 1]) {
      for (const line of box.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('renders all plan lines without a truncation footer', () => {
    const plan = Array.from({ length: 30 }, (_, i) => `- step ${String(i + 1)}`).join('\n');
    const box = new PlanBoxComponent(plan, theme, darkColors.success);
    const out = strip(box.render(80).join('\n'));
    expect(out).toContain('step 1');
    expect(out).toContain('step 30');
    expect(out).not.toContain('more lines');
  });
});
