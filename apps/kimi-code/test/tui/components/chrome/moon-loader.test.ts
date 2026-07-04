import type { TUI } from '@moonshot-ai/pi-tui';
import { visibleWidth } from '@moonshot-ai/pi-tui';
import { afterEach, describe, expect, it } from 'vitest';

import { MoonLoader, type SpinnerStyle } from '#/tui/components/chrome/moon-loader';
import { FOOTBALL_SPINNER_FRAMES } from '#/tui/constant/rendering';

// MoonLoader starts a real setInterval in its constructor, so every loader
// created in these tests must be stopped to avoid leaving live timers behind.
const loaders: MoonLoader[] = [];

function createLoader(style: SpinnerStyle = 'moon'): MoonLoader {
  const ui = { requestRender() {} } as unknown as TUI;
  const loader = new MoonLoader(ui, style);
  loaders.push(loader);
  return loader;
}

afterEach(() => {
  for (const loader of loaders) loader.stop();
  loaders.length = 0;
});

describe('MoonLoader', () => {
  it('keeps the tip out of renderInline so it does not squeeze against the swarm progress bar', () => {
    const loader = createLoader();
    loader.setTip(' · Tip: ctrl+s: steer mid-turn');
    loader.setAvailableWidth(80);

    const inline = loader.renderInline();
    expect(inline).not.toContain('Tip');
    expect(inline).not.toContain('steer');
    expect(inline.trim().length).toBeGreaterThan(0);
  });

  it('still shows the tip on its own row when width allows', () => {
    const loader = createLoader();
    loader.setTip(' · Tip: ctrl+s: steer mid-turn');
    loader.setAvailableWidth(80);

    const row = loader.render(80).join('\n');
    expect(row).toContain('Tip: ctrl+s: steer mid-turn');
  });

  it('renders a football for the football style', () => {
    const loader = createLoader('football');

    expect(loader.renderInline()).toContain('⚽');
  });

  it('keeps every football frame the same width so the label never jitters', () => {
    const widths = FOOTBALL_SPINNER_FRAMES.map((frame) => visibleWidth(frame));
    expect(new Set(widths).size).toBe(1);
  });
});
