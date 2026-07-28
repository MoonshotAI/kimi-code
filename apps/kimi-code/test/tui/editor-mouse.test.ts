import { describe, expect, it, vi } from 'vitest';

import type { TUIState } from '#/tui/kimi-tui';
import {
  DISABLE_TERMINAL_MOUSE_REPORTING,
  ENABLE_TERMINAL_MOUSE_REPORTING,
} from '#/tui/constant/terminal';
import {
  installEditorMouseTracking,
  installTerminalMouseTracking,
  parseSgrMouseEvent,
  resolveEditorMouseTarget,
} from '#/tui/utils/editor-mouse';

type InputListener = Parameters<TUIState['ui']['addInputListener']>[0];

function trackingState() {
  const listeners: InputListener[] = [];
  const removeInputListener = vi.fn();
  const terminal = {
    columns: 40,
    rows: 20,
    write: vi.fn(),
  };
  const ui = {
    addInputListener: vi.fn((listener: InputListener) => {
      listeners.push(listener);
      return removeInputListener;
    }),
    getRenderedViewportTop: vi.fn(() => 0),
  };
  return { listeners, removeInputListener, terminal, ui };
}

describe('terminal mouse input', () => {
  it('classifies SGR left-button events', () => {
    expect(parseSgrMouseEvent('\u001B[<0;10;5M')).toMatchObject({
      type: 'left-down',
      col: 10,
      row: 5,
    });
    expect(parseSgrMouseEvent('\u001B[<32;11;6M')).toMatchObject({
      type: 'left-drag',
      col: 11,
      row: 6,
    });
    expect(parseSgrMouseEvent('\u001B[<0;11;6m')).toMatchObject({
      type: 'left-up',
      col: 11,
      row: 6,
    });
    expect(parseSgrMouseEvent('\u001B[<3;11;6M')).toMatchObject({
      type: 'left-up',
      col: 11,
      row: 6,
    });
    expect(parseSgrMouseEvent('x')).toBeUndefined();
  });

  it('consumes mouse sequences while preserving ordinary input', () => {
    const state = trackingState();
    const events: string[] = [];
    const dispose = installTerminalMouseTracking(
      state as unknown as Pick<TUIState, 'terminal' | 'ui'>,
      (event) => events.push(event.type),
    );

    expect(state.terminal.write).toHaveBeenCalledWith(ENABLE_TERMINAL_MOUSE_REPORTING);
    expect(state.listeners).toHaveLength(1);
    expect(state.listeners[0]?.('\u001B[<0;10;5M')).toEqual({ consume: true });
    expect(state.listeners[0]?.('a\u001B[<32;11;6Mb')).toEqual({ data: 'ab' });
    expect(events).toEqual(['left-down', 'left-drag']);

    dispose();
    expect(state.removeInputListener).toHaveBeenCalledOnce();
    expect(state.terminal.write).toHaveBeenCalledWith(DISABLE_TERMINAL_MOUSE_REPORTING);
  });

  it('drives editor selection from press, drag, and release', () => {
    const state = trackingState();
    state.terminal.rows = 4;
    const editorContainer = {
      children: [] as unknown[],
      render: vi.fn(() => ['editor-top', 'editor-line', 'editor-bottom']),
    };
    const editor = {
      beginSelection: vi.fn(),
      updateSelection: vi.fn(),
      finishSelection: vi.fn(),
      positionAtRenderedCell: vi.fn((row: number, col: number) => ({ line: row - 1, col })),
    };
    editorContainer.children.push(editor);
    const transcript = { render: vi.fn(() => ['transcript']) };
    const ui = {
      ...state.ui,
      children: [transcript, editorContainer],
      getRenderedChildLayout: vi.fn(() => ({
        startRow: 1,
        endRow: 4,
        totalRows: 4,
        width: 40,
      })),
    };

    const dispose = installEditorMouseTracking({
      terminal: state.terminal,
      ui,
      editor,
      editorContainer,
    } as unknown as Pick<TUIState, 'editor' | 'editorContainer' | 'terminal' | 'ui'>);

    const listener = state.listeners[0];
    listener?.('\u001B[<0;2;3M');
    expect(editor.beginSelection).not.toHaveBeenCalled();

    listener?.('\u001B[<0;3;3M');
    listener?.('\u001B[<32;5;3M');
    listener?.('\u001B[<0;5;3m');

    expect(editor.beginSelection).toHaveBeenCalledOnce();
    expect(editor.updateSelection).toHaveBeenCalledOnce();
    expect(editor.finishSelection).toHaveBeenCalledOnce();
    expect(transcript.render).not.toHaveBeenCalled();
    expect(editorContainer.render).not.toHaveBeenCalled();

    dispose();
  });

  it('maps a top-aligned short frame without vertical or prompt-column offset', () => {
    const state = trackingState();
    state.terminal.rows = 6;
    const editor = {};
    const editorContainer = { children: [editor] };
    const ui = {
      ...state.ui,
      children: [editorContainer],
      getRenderedChildLayout: vi.fn(() => ({
        startRow: 1,
        endRow: 4,
        totalRows: 4,
        width: 40,
      })),
    };

    const target = resolveEditorMouseTarget(
      {
        terminal: state.terminal,
        ui,
        editor,
        editorContainer,
      } as unknown as Pick<TUIState, 'editor' | 'editorContainer' | 'terminal' | 'ui'>,
      { row: 3, col: 6 },
      false,
    );

    // Screen row 3 is the editor's first content row. Column 6 is the first
    // text cell after outer gutter + border + `> ` prompt padding.
    expect(target).toEqual({ row: 1, col: 4 });
  });

  it('coalesces high-frequency drag events and resets cleanly between drags', () => {
    vi.useFakeTimers();
    try {
      const state = trackingState();
      state.terminal.rows = 4;
      const editorContainer = { children: [] as unknown[] };
      const editor = {
        beginSelection: vi.fn(),
        updateSelection: vi.fn(),
        finishSelection: vi.fn(),
        positionAtRenderedCell: vi.fn((row: number, col: number) => ({ line: row - 1, col })),
      };
      editorContainer.children.push(editor);
      const ui = {
        ...state.ui,
        children: [editorContainer],
        getRenderedChildLayout: vi.fn(() => ({
          startRow: 0,
          endRow: 3,
          totalRows: 3,
          width: 40,
        })),
      };

      const dispose = installEditorMouseTracking({
        terminal: state.terminal,
        ui,
        editor,
        editorContainer,
      } as unknown as Pick<TUIState, 'editor' | 'editorContainer' | 'terminal' | 'ui'>);
      const listener = state.listeners[0]!;

      for (let drag = 0; drag < 3; drag++) {
        listener('\u001B[<0;3;2M');
        for (let col = 4; col <= 30; col++) {
          listener(`\u001B[<32;${col};2M`);
        }
        expect(editor.updateSelection).toHaveBeenCalledTimes(drag * 2 + 1);
        vi.advanceTimersByTime(16);
        expect(editor.updateSelection).toHaveBeenCalledTimes(drag * 2 + 2);
        listener('\u001B[<0;30;2m');
        expect(editor.finishSelection).toHaveBeenCalledTimes(drag + 1);
        vi.runOnlyPendingTimers();
        expect(editor.updateSelection).toHaveBeenCalledTimes(drag * 2 + 2);
      }

      dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the actual preserved viewport after the editor shrinks', () => {
    const state = trackingState();
    state.terminal.rows = 4;
    const editorContainer = { children: [] as unknown[] };
    const editor = {
      beginSelection: vi.fn(),
      updateSelection: vi.fn(),
      finishSelection: vi.fn(),
      positionAtRenderedCell: vi.fn(() => ({ line: 0, col: 0 })),
    };
    editorContainer.children.push(editor);
    const ui = {
      ...state.ui,
      children: [editorContainer],
      getRenderedViewportTop: vi.fn(() => 2),
      getRenderedChildLayout: vi.fn(() => ({
        startRow: 2,
        endRow: 5,
        totalRows: 5,
        width: 40,
      })),
    };

    installEditorMouseTracking({
      terminal: state.terminal,
      ui,
      editor,
      editorContainer,
    } as unknown as Pick<TUIState, 'editor' | 'editorContainer' | 'terminal' | 'ui'>);

    state.listeners[0]?.('\u001B[<0;3;2M');

    expect(editor.positionAtRenderedCell).toHaveBeenCalledWith(1, 1, false);
    expect(editor.beginSelection).toHaveBeenCalledOnce();
  });

  it('ignores drags that did not start in the editor', () => {
    const state = trackingState();
    state.terminal.rows = 4;
    const editorContainer = {
      children: [] as unknown[],
      render: vi.fn(() => ['editor-top', 'editor-line', 'editor-bottom']),
    };
    const editor = {
      beginSelection: vi.fn(),
      updateSelection: vi.fn(),
      finishSelection: vi.fn(),
      positionAtRenderedCell: vi.fn(() => ({ line: 0, col: 0 })),
    };
    editorContainer.children.push(editor);
    const ui = {
      ...state.ui,
      children: [{ render: vi.fn(() => ['transcript']) }, editorContainer],
      getRenderedChildLayout: vi.fn(() => ({
        startRow: 1,
        endRow: 4,
        totalRows: 4,
        width: 40,
      })),
    };

    installEditorMouseTracking({
      terminal: state.terminal,
      ui,
      editor,
      editorContainer,
    } as unknown as Pick<TUIState, 'editor' | 'editorContainer' | 'terminal' | 'ui'>);

    state.listeners[0]?.('\u001B[<32;5;3M');
    state.listeners[0]?.('\u001B[<0;5;3m');

    expect(editor.beginSelection).not.toHaveBeenCalled();
    expect(editor.updateSelection).not.toHaveBeenCalled();
    expect(editor.finishSelection).not.toHaveBeenCalled();
  });
});
