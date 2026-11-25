import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { Component, Terminal } from '@moonshot-ai/pi-tui';
import { Text, TuiAltScreen, TuiMainScreen } from '@moonshot-ai/pi-tui';

import {
  FramedScrollPane,
  ScreenTakeoverView,
} from '#/tui/components/chrome/screen-takeover-view';
import { beginScreenTakeover, endScreenTakeover } from '#/tui/utils/screen-takeover';

import { VirtualTerminal } from '@moonshot-ai/pi-tui/testing';

function stripAnsi(text: string): string {
  return text
    .replaceAll(/\u001B\[[0-9;?]*[a-zA-Z]/g, '')
    .replaceAll(/\u001B\][^\u0007]*\u0007/g, '');
}

class TestTakeoverView extends ScreenTakeoverView {
  readonly paddedPane: FramedScrollPane;
  readonly flushPane: FramedScrollPane;

  constructor(terminal: Terminal, lines: readonly string[], title?: string) {
    super(terminal);
    this.paddedPane = this.registerPane(
      new FramedScrollPane({
        padX: 1,
        primary: true,
        ...(title === undefined ? {} : { title: () => title }),
        renderContent: () => [...lines],
      }),
    );
    this.flushPane = this.registerPane(
      new FramedScrollPane({
        padX: 0,
        title: () => 'Flush',
        renderContent: () => [...lines],
      }),
    );
    this.addChild(this.paddedPane, { basis: 0, grow: 1, shrink: 1, minSize: 0 });
    this.addChild(this.flushPane, { basis: 0, grow: 1, shrink: 1, minSize: 0 });
  }
}

function stubTerminal(): Terminal {
  return {
    start: () => {},
    stop: () => {},
    drainInput: async () => {},
    write: () => {},
    get columns() {
      return 80;
    },
    get rows() {
      return 24;
    },
    get kittyProtocolActive() {
      return false;
    },
    moveBy: () => {},
    hideCursor: () => {},
    showCursor: () => {},
    clearLine: () => {},
    clearFromCursor: () => {},
    clearScreen: () => {},
    setTitle: () => {},
    setProgress: () => {},
    setProgramStatus: () => {},
  };
}

function line(text: string): Component {
  return new Text(text, 0, 0);
}

describe('screen-takeover', () => {
  it('swaps and restores root children in regular mode', () => {
    const ui = new TuiMainScreen(stubTerminal());
    const transcript = line('transcript');
    const editor = line('editor');
    ui.addChild(transcript);
    ui.addChild(editor);

    const viewer = line('viewer');
    const takeover = beginScreenTakeover(ui, viewer);
    expect(ui.children).toEqual([viewer]);

    endScreenTakeover(ui, takeover);
    expect(ui.children).toEqual([transcript, editor]);
  });

  it('swaps and restores the layout root in fullscreen mode', () => {
    const ui = new TuiAltScreen(stubTerminal());
    const mainRoot = line('main-layout');
    ui.setLayoutRoot(mainRoot);
    expect(ui.children).toHaveLength(0);

    const viewer = line('viewer');
    const takeover = beginScreenTakeover(ui, viewer);
    expect(ui.getLayoutRoot()).toBe(viewer);

    endScreenTakeover(ui, takeover);
    expect(ui.getLayoutRoot()).toBe(mainRoot);
  });

  it('nests takeovers (viewer opened from a viewer)', () => {
    const ui = new TuiAltScreen(stubTerminal());
    const mainRoot = line('main-layout');
    ui.setLayoutRoot(mainRoot);

    const browser = line('browser');
    const first = beginScreenTakeover(ui, browser);
    const detail = line('detail');
    const second = beginScreenTakeover(ui, detail);
    expect(ui.getLayoutRoot()).toBe(detail);

    endScreenTakeover(ui, second);
    expect(ui.getLayoutRoot()).toBe(browser);
    endScreenTakeover(ui, first);
    expect(ui.getLayoutRoot()).toBe(mainRoot);
  });

  it('activates scrollbars only in TuiAltScreen and deactivates them on restore', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `row ${String(i + 1)}`);
    const mainTerm = stubTerminal();
    const mainUi = new TuiMainScreen(mainTerm);
    const mainView = new TestTakeoverView(mainTerm, lines, 'Padded');
    const mainTakeover = beginScreenTakeover(mainUi, mainView);
    const mainRendered = mainView.render(80).map(stripAnsi);
    expect(mainView.paddedPane.scrollView.isScrollbarVisible).toBe(false);
    expect(mainView.flushPane.scrollView.scrollbar).toBe('hidden');
    expect(mainRendered[0]).toContain('╭─ Padded ');
    expect(mainRendered.join('\n')).not.toMatch(/[┃█]/);
    endScreenTakeover(mainUi, mainTakeover);

    const vt = new VirtualTerminal(80, 20);
    const altUi = new TuiAltScreen(vt);
    const altView = new TestTakeoverView(vt, lines, 'Padded');
    const altTakeover = beginScreenTakeover(altUi, altView);
    altUi.start();
    onTestFinished(() => altUi.stop());
    await vt.waitForRender();

    expect(altView.paddedPane.scrollView.isScrollbarVisible).toBe(true);
    expect(altView.flushPane.scrollView.scrollbar).toBe('auto');

    altView.flushPane.scrollView.scrollBy(2);
    expect(altView.flushPane.scrollView.isScrollbarVisible).toBe(true);

    endScreenTakeover(altUi, altTakeover);
    expect(altView.paddedPane.scrollView.isScrollbarVisible).toBe(false);
    expect(altView.flushPane.scrollView.scrollbar).toBe('hidden');
    expect(altView.flushPane.scrollView.isScrollbarVisible).toBe(false);
  });

  it('toggles scrollbars cleanly across nested ScreenTakeoverView takeovers', () => {
    const term = stubTerminal();
    const ui = new TuiAltScreen(term);
    const lines = Array.from({ length: 40 }, (_, i) => `row ${String(i + 1)}`);
    const outer = new TestTakeoverView(term, lines);
    const inner = new TestTakeoverView(term, lines);

    const first = beginScreenTakeover(ui, outer);
    expect(outer.flushPane.scrollView.scrollbar).toBe('auto');

    const second = beginScreenTakeover(ui, inner);
    expect(outer.flushPane.scrollView.scrollbar).toBe('hidden');
    expect(inner.flushPane.scrollView.scrollbar).toBe('auto');

    endScreenTakeover(ui, second);
    expect(inner.flushPane.scrollView.scrollbar).toBe('hidden');
    expect(outer.flushPane.scrollView.scrollbar).toBe('auto');

    endScreenTakeover(ui, first);
    expect(outer.flushPane.scrollView.scrollbar).toBe('hidden');
  });

  it('draws full-height left and right frame rails on frame 1 and across resizes', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `entry-${String(i + 1)}`);
    const vt = new VirtualTerminal(60, 12);
    const ui = new TuiAltScreen(vt);
    const view = new (class extends ScreenTakeoverView {
      constructor() {
        super(vt);
        const pane = this.registerPane(
          new FramedScrollPane({
            padX: 1,
            primary: true,
            renderContent: () => lines,
          }),
        );
        this.addChild(pane, { basis: 0, grow: 1, shrink: 1, minSize: 0 });
      }
    })();

    const takeover = beginScreenTakeover(ui, view);
    ui.start();
    onTestFinished(() => {
      endScreenTakeover(ui, takeover);
      ui.stop();
    });
    await vt.waitForRender();

    const checkRails = (height: number): void => {
      const rows = vt.getViewport().map(stripAnsi);
      expect(rows).toHaveLength(height);
      expect(rows[0]![0]).toBe('╭');
      expect(rows[0]![59]).toBe('╮');
      expect(rows[height - 1]![0]).toBe('╰');
      expect(rows[height - 1]![59]).toBe('╯');
      for (let row = 1; row < height - 1; row++) {
        expect(rows[row]![0]).toBe('│');
        expect(rows[row]![59]).toBe('│');
      }
    };

    checkRails(12);

    vt.resize(60, 32);
    await vt.waitForRender();
    checkRails(32);

    vt.resize(60, 8);
    await vt.waitForRender();
    checkRails(8);
  });

  it('cancels padX: 0 auto-scrollbar hide timers on endScreenTakeover', async () => {
    vi.useFakeTimers();
    const lines = Array.from({ length: 40 }, (_, i) => `row ${String(i + 1)}`);
    const vt = new VirtualTerminal(60, 14);
    const ui = new TuiAltScreen(vt);
    const view = new TestTakeoverView(vt, lines);
    const takeover = beginScreenTakeover(ui, view);
    ui.start();
    onTestFinished(() => {
      ui.stop();
      vi.useRealTimers();
    });
    ui.renderNow();

    view.flushPane.scrollView.scrollBy(3);
    expect(view.flushPane.scrollView.isScrollbarVisible).toBe(true);

    endScreenTakeover(ui, takeover);
    expect(view.flushPane.scrollView.scrollbar).toBe('hidden');
    expect(view.flushPane.scrollView.isScrollbarVisible).toBe(false);
    vi.advanceTimersByTime(5_000);
    expect(view.flushPane.scrollView.isScrollbarVisible).toBe(false);
  });
});
