import { ANIMATION_FRAME_INTERVAL_MS, AnimationFrameScheduler, type TUI } from '@moonshot-ai/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MoonLoader, type SpinnerLabel, type SpinnerStyle } from '#/tui/components/chrome/moon-loader';
import { MOON_LOADER_FRAME_MS } from '#/tui/constant/rendering';

// MoonLoader requests animation frames from its constructor, so every loader
// created in these tests must be stopped to avoid leaving live timers behind.
const loaders: MoonLoader[] = [];

function createLoader(style: SpinnerStyle = 'moon', label?: SpinnerLabel) {
  const frames = new AnimationFrameScheduler();
  const requestRender = vi.fn();
  const ui = {
    requestRender,
    requestAnimationFrame: (callback: (time: number) => void) => frames.requestAnimationFrame(callback),
    cancelAnimationFrame: (handle: number) => {
      frames.cancelAnimationFrame(handle);
    },
  } as unknown as TUI;
  const loader = new MoonLoader(ui, style, undefined, label);
  loaders.push(loader);
  return { loader, requestRender };
}

function firstAnimationFrameAtOrAfter(ms: number): number {
  return Math.ceil(ms / ANIMATION_FRAME_INTERVAL_MS) * ANIMATION_FRAME_INTERVAL_MS;
}

afterEach(() => {
  for (const loader of loaders) loader.stop();
  loaders.length = 0;
  vi.useRealTimers();
});

describe('MoonLoader', () => {
  it('keeps the tip out of renderInline so it does not squeeze against the swarm progress bar', () => {
    const { loader } = createLoader();
    loader.setTip(' · Tip: ctrl+s: steer mid-turn');
    loader.setAvailableWidth(80);

    const inline = loader.renderInline();
    expect(inline).not.toContain('Tip');
    expect(inline).not.toContain('steer');
    expect(inline.trim().length).toBeGreaterThan(0);
  });

  it('still shows the tip on its own row when width allows', () => {
    const { loader } = createLoader();
    loader.setTip(' · Tip: ctrl+s: steer mid-turn');
    loader.setAvailableWidth(80);

    const row = loader.render(80).join('\n');
    expect(row).toContain('Tip: ctrl+s: steer mid-turn');
  });

  it.each([
    ['moon', ['🌑', '🌒', '🌓']],
    ['braille', ['⠋', '⠙', '⠹']],
  ] as const)('shows the next %s frame on the first animation frame after each frame duration and stops requesting frames after stop()', (style, [first, second, third]) => {
    vi.useFakeTimers();
    const { loader, requestRender } = createLoader(style);
    const secondShownAt = firstAnimationFrameAtOrAfter(MOON_LOADER_FRAME_MS);
    const thirdShownAt = firstAnimationFrameAtOrAfter(2 * MOON_LOADER_FRAME_MS);
    expect(loader.renderInline()).toBe(first);

    vi.advanceTimersByTime(secondShownAt - 1);
    expect(loader.renderInline()).toBe(first);
    vi.advanceTimersByTime(1);
    expect(loader.renderInline()).toBe(second);
    vi.advanceTimersByTime(thirdShownAt - secondShownAt - 1);
    expect(loader.renderInline()).toBe(second);
    vi.advanceTimersByTime(1);
    expect(loader.renderInline()).toBe(third);

    loader.stop();
    requestRender.mockClear();
    vi.advanceTimersByTime(1_000);
    expect(loader.renderInline()).toBe(third);
    expect(requestRender).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('evaluates a live label at each animation frame time without a timer of its own', () => {
    vi.useFakeTimers();
    const startedAt = performance.now();
    const { loader } = createLoader('braille', (now) => `Working for ${String(Math.floor((now - startedAt) / 1000))}s`);
    expect(loader.renderInline()).toBe('⠋ Working for 0s');
    expect(loader.currentLabel).toBe('Working for 0s');

    vi.advanceTimersByTime(firstAnimationFrameAtOrAfter(startedAt + 2_000) - startedAt);
    expect(loader.renderInline()).toMatch(/^\S Working for 2s$/u);
    expect(loader.currentLabel).toBe('Working for 2s');
    expect(vi.getTimerCount()).toBe(1);

    loader.setLabel('Compacting…');
    expect(loader.renderInline()).toMatch(/^\S Compacting…$/u);
    loader.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
