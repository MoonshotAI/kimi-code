import type { Container, TUI } from '@moonshot-ai/pi-tui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { MoonLoader } from '#/tui/components/chrome/moon-loader';
import {
  disposeFootballKick,
  FOOTBALL_KICK_MS,
  FootballKick,
  isFootballActive,
  setFootballActive,
  tryHandleFootballCommand,
} from '#/tui/easter-eggs/football';

function makeContainer(): { container: Container; children: unknown[] } {
  const children: unknown[] = [];
  const container = {
    addChild: (child: unknown) => children.push(child),
    removeChild: (child: unknown) => {
      const index = children.indexOf(child);
      if (index >= 0) children.splice(index, 1);
    },
  } as unknown as Container;
  return { container, children };
}

function makeUi(): { ui: TUI; requestRender: ReturnType<typeof vi.fn> } {
  const requestRender = vi.fn();
  const ui = { requestRender } as unknown as TUI;
  return { ui, requestRender };
}

describe('FootballKick', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    disposeFootballKick();
    vi.useRealTimers();
  });

  it('adds a spinning football loader to the container on construction', () => {
    const { ui } = makeUi();
    const { container, children } = makeContainer();

    const kick = new FootballKick(ui, container);

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(MoonLoader);

    kick.dispose();
  });

  it('requests renders while spinning', () => {
    const { ui, requestRender } = makeUi();
    const { container } = makeContainer();

    const kick = new FootballKick(ui, container);
    kick.start();
    requestRender.mockClear();

    vi.advanceTimersByTime(80 * 3);

    expect(requestRender).toHaveBeenCalled();
  });

  it('settles on the easter-egg tip after the kick duration', () => {
    const { ui } = makeUi();
    const { container, children } = makeContainer();

    const kick = new FootballKick(ui, container);
    kick.start();

    vi.advanceTimersByTime(FOOTBALL_KICK_MS);

    const loader = children[0] as MoonLoader;
    const row = loader.render(200).join('\n');
    expect(row).toContain('Goooal!');
    expect(row).toContain('spinning football');
    expect(row).toContain('/football off');
  });

  it('dispose before settle removes the loader and skips the tip', () => {
    const { ui } = makeUi();
    const { container, children } = makeContainer();

    const kick = new FootballKick(ui, container);
    kick.start();
    vi.advanceTimersByTime(80 * 2);

    kick.dispose();

    expect(children).toHaveLength(0);
    // The settle timer must not fire after dispose.
    vi.advanceTimersByTime(FOOTBALL_KICK_MS + 1000);
    expect(children).toHaveLength(0);
  });
});

function makeHost(): {
  host: SlashCommandHost;
  children: unknown[];
  status: string[];
  requestRender: ReturnType<typeof vi.fn>;
} {
  const { ui, requestRender } = makeUi();
  const { container, children } = makeContainer();
  const status: string[] = [];
  const host = {
    state: { ui, transcriptContainer: container },
    showStatus: (msg: string) => status.push(msg),
  } as unknown as SlashCommandHost;
  return { host, children, status, requestRender };
}

describe('tryHandleFootballCommand', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setFootballActive(false);
  });

  afterEach(() => {
    disposeFootballKick();
    setFootballActive(false);
    vi.useRealTimers();
  });

  it('claims /football, turns the loader into a football, and plays the animation', () => {
    const { host, children, status } = makeHost();

    const handled = tryHandleFootballCommand(host, { name: 'football', args: '' });

    expect(handled).toBe(true);
    expect(isFootballActive()).toBe(true);
    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(MoonLoader);
    expect(status).toHaveLength(0);
  });

  it('accepts the typo-tolerant /footerball alias', () => {
    const { host } = makeHost();

    const handled = tryHandleFootballCommand(host, { name: 'footerball', args: '' });

    expect(handled).toBe(true);
    expect(isFootballActive()).toBe(true);
  });

  it('/football off restores the moon loader and shows a status', () => {
    const { host, status } = makeHost();
    tryHandleFootballCommand(host, { name: 'football', args: '' });
    expect(isFootballActive()).toBe(true);

    const handled = tryHandleFootballCommand(host, { name: 'football', args: 'off' });

    expect(handled).toBe(true);
    expect(isFootballActive()).toBe(false);
    expect(status.join(' ')).toContain('moon loader');
  });

  it('ignores case and surrounding whitespace in the sub-command', () => {
    const { host } = makeHost();
    setFootballActive(true);

    tryHandleFootballCommand(host, { name: 'football', args: '  OFF  ' });

    expect(isFootballActive()).toBe(false);
  });

  it('does not claim other commands', () => {
    const { host, children } = makeHost();

    const handled = tryHandleFootballCommand(host, { name: 'help', args: '' });

    expect(handled).toBe(false);
    expect(isFootballActive()).toBe(false);
    expect(children).toHaveLength(0);
  });

  it('supersedes a previous in-flight kick so animations do not stack', () => {
    const { host, children } = makeHost();

    tryHandleFootballCommand(host, { name: 'football', args: '' });
    expect(children).toHaveLength(1);

    tryHandleFootballCommand(host, { name: 'football', args: '' });

    // The first kick was disposed (removed); only the new loader remains.
    expect(children).toHaveLength(1);
  });
});
