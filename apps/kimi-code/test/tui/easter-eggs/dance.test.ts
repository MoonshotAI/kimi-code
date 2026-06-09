import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DANCE_FLOW_MS,
  DANCE_FRAME_MS,
  getRainbowDanceView,
  installRainbowDance,
  RainbowDance,
  rainbowText,
  setRainbowDance,
  tryHandleDanceCommand,
} from '#/tui/easter-eggs/dance';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { darkColors } from '#/tui/theme/colors';

const TRUECOLOR_PATTERN = /\[38;2;(\d+);(\d+);(\d+)m/g;

/** Ordered list of "r,g,b" truecolor codes in the order they appear. */
function truecolorCodes(text: string): string[] {
  return [...text.matchAll(TRUECOLOR_PATTERN)].map((m) => `${m[1]},${m[2]},${m[3]}`);
}

describe('RainbowDance', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts uncolored — the banner keeps its default look', () => {
    const dance = new RainbowDance(vi.fn());

    expect(dance.colored).toBe(false);
    expect(dance.phase).toBe(0);
  });

  it('flows while dancing and requests renders', () => {
    vi.useFakeTimers();
    const requestRender = vi.fn();
    const dance = new RainbowDance(requestRender);

    dance.start({ hold: false });
    expect(dance.colored).toBe(true);

    const before = dance.phase;
    vi.advanceTimersByTime(DANCE_FRAME_MS);
    expect(dance.phase).not.toBe(before);
    expect(requestRender).toHaveBeenCalled();
  });

  it('fades back to default after the flow when not holding', () => {
    vi.useFakeTimers();
    const dance = new RainbowDance(vi.fn());

    dance.start({ hold: false });
    vi.advanceTimersByTime(DANCE_FLOW_MS + DANCE_FRAME_MS);

    expect(dance.colored).toBe(false);
    expect(dance.phase).toBe(0);
  });

  it('freezes into a static rainbow after the flow when holding', () => {
    vi.useFakeTimers();
    const dance = new RainbowDance(vi.fn());

    dance.start({ hold: true });
    vi.advanceTimersByTime(DANCE_FLOW_MS + DANCE_FRAME_MS);

    expect(dance.colored).toBe(true);
    const frozen = dance.phase;
    vi.advanceTimersByTime(DANCE_FRAME_MS * 10);
    expect(dance.phase).toBe(frozen);
  });

  it('stops on demand back to the default colors and clears its timers', () => {
    vi.useFakeTimers();
    const requestRender = vi.fn();
    const dance = new RainbowDance(requestRender);

    dance.start({ hold: true });
    vi.advanceTimersByTime(DANCE_FRAME_MS * 3);
    expect(dance.phase).toBeGreaterThan(0);

    requestRender.mockClear();
    dance.stop();
    expect(dance.colored).toBe(false);
    expect(dance.phase).toBe(0);
    expect(requestRender).toHaveBeenCalled();

    requestRender.mockClear();
    vi.advanceTimersByTime(DANCE_FRAME_MS * 5);
    expect(requestRender).not.toHaveBeenCalled();
  });

  it('dispose clears timers silently, without a final render', () => {
    vi.useFakeTimers();
    const requestRender = vi.fn();
    const dance = new RainbowDance(requestRender);

    dance.start({ hold: false });
    vi.advanceTimersByTime(DANCE_FRAME_MS * 2);
    requestRender.mockClear();

    dance.dispose();
    expect(requestRender).not.toHaveBeenCalled();

    vi.advanceTimersByTime(DANCE_FLOW_MS + DANCE_FRAME_MS * 10);
    expect(requestRender).not.toHaveBeenCalled();
  });

  it('advances the phase by one per frame while flowing', () => {
    vi.useFakeTimers();
    const dance = new RainbowDance(vi.fn());

    dance.start({ hold: true });
    vi.advanceTimersByTime(DANCE_FRAME_MS * 5);
    expect(dance.phase).toBe(5);

    // Monotonic — the dance state itself has no palette-length cycle.
    vi.advanceTimersByTime(DANCE_FRAME_MS * 5);
    expect(dance.phase).toBe(10);
  });
});

describe('rainbowText', () => {
  const previousChalkLevel = chalk.level;

  beforeEach(() => {
    chalk.level = 3;
  });

  afterEach(() => {
    chalk.level = previousChalkLevel;
  });

  it('assigns each visible character the next palette color', () => {
    const out = rainbowText('abcd', ['#111111', '#226622', '#aa33cc', '#44ddee'], 0);

    expect(truecolorCodes(out)).toEqual([
      '17,17,17',
      '34,102,34',
      '170,51,204',
      '68,221,238',
    ]);
  });

  it('does not consume a palette slot for spaces', () => {
    const out = rainbowText('a b', ['#111111', '#226622'], 0);

    expect(truecolorCodes(out)).toEqual(['17,17,17', '34,102,34']);
  });

  it('starts from the given offset', () => {
    const out = rainbowText('a', ['#111111', '#226622'], 1);

    expect(truecolorCodes(out)).toEqual(['34,102,34']);
  });
});

describe('installRainbowDance', () => {
  afterEach(() => {
    setRainbowDance(undefined);
    vi.useRealTimers();
  });

  it('returns a disposer that clears timers and uninstalls the controller', () => {
    vi.useFakeTimers();
    const requestRender = vi.fn();
    const dispose = installRainbowDance(requestRender);
    const host = {
      showStatus: vi.fn(),
      state: { theme: { palette: darkColors } },
    } as unknown as SlashCommandHost;

    tryHandleDanceCommand(host, { name: 'dance', args: 'on' });
    vi.advanceTimersByTime(DANCE_FRAME_MS * 2);
    expect(requestRender).toHaveBeenCalled();

    requestRender.mockClear();
    dispose();

    expect(getRainbowDanceView()).toBeUndefined();
    vi.advanceTimersByTime(DANCE_FLOW_MS + DANCE_FRAME_MS * 10);
    expect(requestRender).not.toHaveBeenCalled();
  });
});

interface DanceCall {
  fn: 'start' | 'stop';
  hold?: boolean;
}

function makeHost(): { host: SlashCommandHost; calls: DanceCall[]; status: string[] } {
  const calls: DanceCall[] = [];
  const status: string[] = [];
  const rainbowDance = {
    colored: false,
    phase: 0,
    start: (opts: { hold: boolean }) => calls.push({ fn: 'start', hold: opts.hold }),
    stop: () => calls.push({ fn: 'stop' }),
    dispose: () => {},
  };
  setRainbowDance(rainbowDance);
  const host = {
    showStatus: (msg: string) => status.push(msg),
    state: { theme: { palette: darkColors } },
  } as unknown as SlashCommandHost;
  return { host, calls, status };
}

describe('tryHandleDanceCommand', () => {
  let host: SlashCommandHost;
  let calls: DanceCall[];
  let status: string[];

  beforeEach(() => {
    ({ host, calls, status } = makeHost());
  });

  afterEach(() => {
    setRainbowDance(undefined);
  });

  it('claims /dance, flowing then fading, and hints at /dance on', () => {
    const handled = tryHandleDanceCommand(host, { name: 'dance', args: '' });

    expect(handled).toBe(true);
    expect(calls).toEqual([{ fn: 'start', hold: false }]);
    expect(status.join(' ')).toContain('/dance on');
  });

  it('holds the rainbow for /dance on and hints at /dance off', () => {
    const handled = tryHandleDanceCommand(host, { name: 'dance', args: 'on' });

    expect(handled).toBe(true);
    expect(calls).toEqual([{ fn: 'start', hold: true }]);
    expect(status.join(' ')).toContain('/dance off');
  });

  it('turns the rainbow off for /dance off', () => {
    const handled = tryHandleDanceCommand(host, { name: 'dance', args: 'off' });

    expect(handled).toBe(true);
    expect(calls).toEqual([{ fn: 'stop' }]);
  });

  it('ignores case and surrounding whitespace in the sub-command', () => {
    tryHandleDanceCommand(host, { name: 'dance', args: '  ON  ' });

    expect(calls).toEqual([{ fn: 'start', hold: true }]);
  });

  it('treats an unknown sub-command as a one-off dance', () => {
    tryHandleDanceCommand(host, { name: 'dance', args: 'wiggle' });

    expect(calls).toEqual([{ fn: 'start', hold: false }]);
  });

  it('does not claim other commands, so they fall through normally', () => {
    const handled = tryHandleDanceCommand(host, { name: 'help', args: '' });

    expect(handled).toBe(false);
    expect(calls).toEqual([]);
  });
});
