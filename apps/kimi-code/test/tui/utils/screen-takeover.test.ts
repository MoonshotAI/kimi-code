import { describe, expect, it } from 'vitest';

import type { Component, Terminal } from '@moonshot-ai/pi-tui';
import { Text, TuiAltScreen, TuiMainScreen } from '@moonshot-ai/pi-tui';

import {
  beginScreenTakeover,
  endScreenTakeover,
  hasActiveScreenTakeover,
} from '#/tui/utils/screen-takeover';

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
  it('swaps and restores root children in regular mode and tracks active state', () => {
    const ui = new TuiMainScreen(stubTerminal());
    const transcript = line('transcript');
    const editor = line('editor');
    ui.addChild(transcript);
    ui.addChild(editor);

    expect(hasActiveScreenTakeover(ui)).toBe(false);

    const viewer = line('viewer');
    const takeover = beginScreenTakeover(ui, viewer);
    expect(hasActiveScreenTakeover(ui)).toBe(true);
    expect(ui.children).toEqual([viewer]);

    endScreenTakeover(ui, takeover);
    expect(hasActiveScreenTakeover(ui)).toBe(false);
    expect(ui.children).toEqual([transcript, editor]);
  });

  it('swaps and restores the layout root in fullscreen mode and tracks active state', () => {
    const ui = new TuiAltScreen(stubTerminal());
    const mainRoot = line('main-layout');
    ui.setLayoutRoot(mainRoot);
    expect(ui.children).toHaveLength(0);
    expect(hasActiveScreenTakeover(ui)).toBe(false);

    const viewer = line('viewer');
    const takeover = beginScreenTakeover(ui, viewer);
    expect(hasActiveScreenTakeover(ui)).toBe(true);
    expect(ui.getLayoutRoot()).toBe(viewer);

    endScreenTakeover(ui, takeover);
    expect(hasActiveScreenTakeover(ui)).toBe(false);
    expect(ui.getLayoutRoot()).toBe(mainRoot);
  });

  it('nests takeovers (viewer opened from a viewer) until all are ended', () => {
    const ui = new TuiAltScreen(stubTerminal());
    const mainRoot = line('main-layout');
    ui.setLayoutRoot(mainRoot);

    const browser = line('browser');
    const first = beginScreenTakeover(ui, browser);
    const detail = line('detail');
    const second = beginScreenTakeover(ui, detail);
    expect(hasActiveScreenTakeover(ui)).toBe(true);
    expect(ui.getLayoutRoot()).toBe(detail);

    endScreenTakeover(ui, second);
    expect(hasActiveScreenTakeover(ui)).toBe(true);
    expect(ui.getLayoutRoot()).toBe(browser);
    endScreenTakeover(ui, first);
    expect(hasActiveScreenTakeover(ui)).toBe(false);
    expect(ui.getLayoutRoot()).toBe(mainRoot);
  });

  it('ignores duplicate or unregistered endScreenTakeover calls idempotently', () => {
    const ui = new TuiMainScreen(stubTerminal());
    const original = line('original');
    ui.addChild(original);

    const viewer = line('viewer');
    const takeover = beginScreenTakeover(ui, viewer);
    endScreenTakeover(ui, takeover);

    const replacement = line('replacement');
    ui.clear();
    ui.addChild(replacement);

    endScreenTakeover(ui, takeover);
    endScreenTakeover(ui, { kind: 'children', children: [original] });
    expect(hasActiveScreenTakeover(ui)).toBe(false);
    expect(ui.children).toEqual([replacement]);
  });
});
