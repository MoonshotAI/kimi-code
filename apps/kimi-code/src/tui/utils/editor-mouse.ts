import type { Component } from '@earendil-works/pi-tui';

import { CHROME_GUTTER } from '#/tui/constant/rendering';
import {
  DISABLE_TERMINAL_MOUSE_REPORTING,
  ENABLE_TERMINAL_MOUSE_REPORTING,
} from '#/tui/constant/terminal';
import type { TUIState } from '#/tui/tui-state';

export {
  DISABLE_TERMINAL_MOUSE_REPORTING,
  ENABLE_TERMINAL_MOUSE_REPORTING,
} from '#/tui/constant/terminal';

interface EditorMouseTarget {
  readonly row: number;
  readonly col: number;
  readonly width: number;
}

type EditorMouseState = Pick<TUIState, 'editor' | 'editorContainer' | 'terminal' | 'ui'>;
type TerminalMouseTrackingState = Pick<TUIState, 'terminal' | 'ui'>;

export interface TerminalMouseEvent {
  readonly button: number;
  readonly col: number;
  readonly row: number;
  readonly final: 'M' | 'm';
}

const SGR_MOUSE_EVENT = /^\u001B\[<(\d+);(\d+);(\d+)([Mm])$/;
const MOUSE_MOTION_BIT = 32;
const MOUSE_WHEEL_BIT = 64;
const MOUSE_BUTTON_MASK = 3;

export function parseSgrMouseEvent(data: string): TerminalMouseEvent | undefined {
  const match = data.match(SGR_MOUSE_EVENT);
  if (match === null) return undefined;

  const button = Number(match[1]);
  const col = Number(match[2]);
  const row = Number(match[3]);
  const final = match[4] as 'M' | 'm';
  if (!Number.isInteger(button) || !Number.isInteger(col) || !Number.isInteger(row)) {
    return undefined;
  }
  if (col < 1 || row < 1) return undefined;

  return { button, col, row, final };
}

export function isPrimaryMousePress(event: TerminalMouseEvent): boolean {
  return (
    event.final === 'M' &&
    (event.button & MOUSE_WHEEL_BIT) === 0 &&
    (event.button & MOUSE_MOTION_BIT) === 0 &&
    (event.button & MOUSE_BUTTON_MASK) === 0
  );
}

export function installTerminalMouseTracking(
  state: TerminalMouseTrackingState,
  onMouseEvent: (event: TerminalMouseEvent) => void,
): () => void {
  const disposeInputListener = state.ui.addInputListener((data) => {
    const event = parseSgrMouseEvent(data);
    if (event === undefined) return undefined;

    onMouseEvent(event);
    return { consume: true };
  });
  state.terminal.write(ENABLE_TERMINAL_MOUSE_REPORTING);

  return () => {
    disposeInputListener();
    state.terminal.write(DISABLE_TERMINAL_MOUSE_REPORTING);
  };
}

export function installEditorMouseTracking(state: EditorMouseState): () => void {
  return installTerminalMouseTracking(state, (event) => {
    if (!isPrimaryMousePress(event)) return;
    const target = resolveEditorMouseTarget(state, event);
    if (target === undefined) return;
    if (!state.editor.moveCursorToMousePosition(target.row, target.col, target.width)) return;

    state.ui.requestRender();
  });
}

export function resolveEditorMouseTarget(
  state: EditorMouseState,
  event: TerminalMouseEvent,
): EditorMouseTarget | undefined {
  if (!state.editorContainer.children.includes(state.editor)) return undefined;

  const { columns: terminalWidth, rows: terminalRows } = state.terminal;
  if (event.col < 1 || event.row < 1 || event.row > terminalRows) return undefined;

  const layout = locateEditorContainer(state.ui.children, state.editorContainer, terminalWidth);
  if (layout === undefined) return undefined;

  const viewportTop = Math.max(0, layout.totalRows - terminalRows);
  const screenTop = Math.max(0, terminalRows - layout.totalRows);
  const screenRow = event.row - 1;
  const logicalRow = viewportTop + screenRow - screenTop;
  if (logicalRow < layout.startRow || logicalRow >= layout.endRow) return undefined;

  const editorWidth = Math.max(1, terminalWidth - CHROME_GUTTER * 2);
  const editorCol = event.col - CHROME_GUTTER - 1;
  if (editorCol < 0 || editorCol >= editorWidth) return undefined;

  return {
    row: logicalRow - layout.startRow,
    col: editorCol,
    width: editorWidth,
  };
}

function locateEditorContainer(
  children: readonly Component[],
  editorContainer: Component,
  width: number,
):
  | {
      readonly startRow: number;
      readonly endRow: number;
      readonly totalRows: number;
    }
  | undefined {
  let row = 0;
  let startRow: number | undefined;
  let endRow = 0;

  for (const child of children) {
    const lineCount = child.render(width).length;
    if (child === editorContainer) {
      startRow = row;
      endRow = row + lineCount;
    }
    row += lineCount;
  }

  if (startRow === undefined) return undefined;
  return { startRow, endRow, totalRows: row };
}
