import type { TUI } from '@moonshot-ai/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { MoonLoader } from '#/tui/components/chrome/moon-loader';
import { MOON_SPINNER_INTERVAL_MS } from '#/tui/constant/rendering';

function strip(text: string): string {
  return text.replaceAll(/\[[0-9;]*m/g, '');
}

function fakeUi(): TUI {
  return { requestRender: vi.fn() } as unknown as TUI;
}

describe('MoonLoader label function', () => {
  it('re-evaluates the label function on each spinner tick', () => {
    vi.useFakeTimers();
    try {
      const loader = new MoonLoader(fakeUi(), 'moon');
      let attempt = 2;
      loader.setLabelFn(() => `attempt ${attempt}/10`);
      expect(strip(loader.render(80).join('\n'))).toContain('attempt 2/10');

      attempt = 3;
      vi.advanceTimersByTime(MOON_SPINNER_INTERVAL_MS);
      expect(strip(loader.render(80).join('\n'))).toContain('attempt 3/10');

      loader.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('setLabel clears a previously set label function', () => {
    vi.useFakeTimers();
    try {
      const loader = new MoonLoader(fakeUi(), 'moon');
      let attempt = 2;
      loader.setLabelFn(() => `attempt ${attempt}/10`);
      loader.setLabel('static label');

      attempt = 3;
      vi.advanceTimersByTime(MOON_SPINNER_INTERVAL_MS);
      const rendered = strip(loader.render(80).join('\n'));
      expect(rendered).toContain('static label');
      expect(rendered).not.toContain('attempt');

      loader.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
