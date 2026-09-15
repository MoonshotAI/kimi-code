import { describe, expect, it } from 'vitest';

import type { Component, Terminal } from '@moonshot-ai/pi-tui';
import { Text, TuiAltScreen, TuiMainScreen } from '@moonshot-ai/pi-tui';

import { beginScreenTakeover, endScreenTakeover } from '#/tui/utils/screen-takeover';

/** Minimal Terminal stub: takeover logic never starts the terminal. */
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
    // The root children list is unused in fullscreen and stays empty.
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
});
