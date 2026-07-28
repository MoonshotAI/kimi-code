import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_TERMINAL_TITLE_LENGTH } from '#/tui/constant/terminal';
import { TITLE_SPINNER_STYLES } from '#/tui/constant/title-spinners';
import {
  TerminalTitleSpinnerController,
  type TerminalTitleSpinnerHost,
} from '#/tui/controllers/terminal-title-spinner';

interface FakeHostState {
  busy: boolean;
  phase: string;
  staticTitle: string;
}

function createHost(state: FakeHostState): { host: TerminalTitleSpinnerHost; titles: string[] } {
  const titles: string[] = [];
  const host: TerminalTitleSpinnerHost = {
    setTitle: vi.fn((label: string) => {
      titles.push(label);
    }),
    staticTitle: () => state.staticTitle,
    isBusy: () => state.busy,
    streamingPhase: () => state.phase,
  };
  return { host, titles };
}

describe('TerminalTitleSpinnerController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes the static title and runs no timer when idle', () => {
    const { host, titles } = createHost({ busy: false, phase: 'idle', staticTitle: 'My Session' });
    const controller = new TerminalTitleSpinnerController(host, 'moon');
    controller.sync();
    expect(titles).toEqual(['My Session']);
    vi.advanceTimersByTime(2000);
    expect(titles).toEqual(['My Session']);
  });

  it('animates the title with the selected style while busy', () => {
    const { host, titles } = createHost({ busy: true, phase: 'thinking', staticTitle: 'Fix bug' });
    const frames = TITLE_SPINNER_STYLES['line']!.frames;
    const interval = TITLE_SPINNER_STYLES['line']!.interval;
    const controller = new TerminalTitleSpinnerController(host, 'line');
    controller.sync();
    expect(titles[0]).toBe(`${frames[0]} Fix bug`);
    vi.advanceTimersByTime(interval);
    expect(titles[1]).toBe(`${frames[1]} Fix bug`);
    controller.dispose();
  });

  it('runs a single timer across repeated syncs while busy', () => {
    const { host, titles } = createHost({ busy: true, phase: 'thinking', staticTitle: 'x' });
    const interval = TITLE_SPINNER_STYLES['line']!.interval;
    const controller = new TerminalTitleSpinnerController(host, 'line');
    controller.sync();
    controller.sync();
    controller.sync();
    const writesBefore = titles.length;
    vi.advanceTimersByTime(interval);
    // Exactly one timer tick fires, so exactly one extra write happens.
    expect(titles.length).toBe(writesBefore + 1);
    controller.dispose();
  });

  it('off keeps the static title even while busy', () => {
    const { host, titles } = createHost({ busy: true, phase: 'thinking', staticTitle: 'S' });
    const controller = new TerminalTitleSpinnerController(host, 'off');
    controller.sync();
    vi.advanceTimersByTime(2000);
    expect(titles).toEqual(['S']);
  });

  it('phase maps the streaming phase to a glyph without any timer', () => {
    const state: FakeHostState = { busy: true, phase: 'thinking', staticTitle: 'S' };
    const { host, titles } = createHost(state);
    const controller = new TerminalTitleSpinnerController(host, 'phase');
    controller.sync();
    expect(titles[0]).toBe('✦ S');
    state.phase = 'shell';
    controller.sync();
    expect(titles[1]).toBe('▸ S');
    vi.advanceTimersByTime(5000);
    expect(titles).toHaveLength(2);
  });

  it('dispose stops the timer and restores the static title', () => {
    const { host, titles } = createHost({ busy: true, phase: 'thinking', staticTitle: 'Done' });
    const controller = new TerminalTitleSpinnerController(host, 'line');
    controller.sync();
    controller.dispose();
    expect(titles.at(-1)).toBe('Done');
    const countAfterDispose = titles.length;
    vi.advanceTimersByTime(2000);
    expect(titles).toHaveLength(countAfterDispose);
  });

  it('unknown style falls back to the default spinner', () => {
    const { host, titles } = createHost({ busy: true, phase: 'thinking', staticTitle: 'T' });
    const controller = new TerminalTitleSpinnerController(host, 'definitely-not-a-style');
    const firstFrame = TITLE_SPINNER_STYLES['moon']!.frames[0];
    controller.sync();
    expect(titles[0]).toBe(`${firstFrame} T`);
    controller.dispose();
  });

  it('keeps the composed title within the terminal-title cap', () => {
    const longTitle = 'x'.repeat(MAX_TERMINAL_TITLE_LENGTH + 8);
    const { host, titles } = createHost({ busy: true, phase: 'thinking', staticTitle: longTitle });
    const controller = new TerminalTitleSpinnerController(host, 'line');
    controller.sync();
    expect(titles[0]).toHaveLength(MAX_TERMINAL_TITLE_LENGTH);
    expect(titles[0]).toBe(`| ${'x'.repeat(MAX_TERMINAL_TITLE_LENGTH - 2)}`);
    controller.dispose();
  });

  it('does not split a surrogate pair at the truncation boundary', () => {
    // 29 ASCII chars plus one emoji = 31 UTF-16 units; with the `| ` prefix
    // the composed title is 33 units, so a naive slice would keep a lone high
    // surrogate at the cap.
    const longTitle = `${'x'.repeat(29)}\u{1F311}`;
    const { host, titles } = createHost({ busy: true, phase: 'thinking', staticTitle: longTitle });
    const controller = new TerminalTitleSpinnerController(host, 'line');
    controller.sync();
    expect(titles[0]).toBe(`| ${'x'.repeat(29)}`);
    controller.dispose();
  });

  it('drops a multi-code-point grapheme whole instead of splitting it', () => {
    // 27 ASCII chars plus a flag emoji (two regional indicators, 4 UTF-16
    // units); with the `| ` prefix the composed title is 33 units, so the
    // flag straddles the 32-unit cap and must be dropped as one grapheme.
    const longTitle = `${'a'.repeat(27)}\u{1F1E8}\u{1F1F3}`;
    const { host, titles } = createHost({ busy: true, phase: 'thinking', staticTitle: longTitle });
    const controller = new TerminalTitleSpinnerController(host, 'line');
    controller.sync();
    expect(titles[0]).toBe(`| ${'a'.repeat(27)}`);
    controller.dispose();
  });

  it('keeps the phase title within the terminal-title cap', () => {
    const longTitle = 'y'.repeat(MAX_TERMINAL_TITLE_LENGTH + 8);
    const { host, titles } = createHost({ busy: true, phase: 'thinking', staticTitle: longTitle });
    const controller = new TerminalTitleSpinnerController(host, 'phase');
    controller.sync();
    expect(titles[0]).toHaveLength(MAX_TERMINAL_TITLE_LENGTH);
    expect(titles[0]).toBe(`✦ ${'y'.repeat(MAX_TERMINAL_TITLE_LENGTH - 2)}`);
  });

  it('ignores inherited phase keys instead of stringifying them', () => {
    const { host, titles } = createHost({ busy: true, phase: 'constructor', staticTitle: 'S' });
    const controller = new TerminalTitleSpinnerController(host, 'phase');
    controller.sync();
    expect(titles[0]).toBe('S');
  });
});
