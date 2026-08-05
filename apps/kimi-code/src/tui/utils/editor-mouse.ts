import type { EditorPosition } from '@moonshot-ai/pi-tui';

import { CHROME_GUTTER } from '#/tui/constant/rendering';
import {
  DISABLE_TERMINAL_MOUSE_REPORTING,
  ENABLE_TERMINAL_MOUSE_REPORTING,
} from '#/tui/constant/terminal';
import type { TUIState } from '#/tui/tui-state';

interface EditorMouseTarget {
  readonly row: number;
  readonly col: number;
}

type EditorMouseState = Pick<TUIState, 'editor' | 'editorContainer' | 'terminal' | 'ui'>;
type TerminalMouseTrackingState = Pick<TUIState, 'terminal' | 'ui'>;

export type TerminalMouseEventType = 'left-down' | 'left-drag' | 'left-up' | 'other';

export interface TerminalMouseEvent {
  readonly type: TerminalMouseEventType;
  readonly button: number;
  readonly col: number;
  readonly row: number;
  readonly final: 'M' | 'm';
}

// oxlint-disable-next-line no-control-regex -- ESC is required for SGR mouse input.
const SGR_MOUSE_EVENT = /\u001B\[<(\d+);(\d+);(\d+)([Mm])/g;
const MOUSE_MOTION_BIT = 32;
const MOUSE_WHEEL_BIT = 64;
const MOUSE_BUTTON_MASK = 3;
const DRAG_UPDATE_INTERVAL_MS = 16;

function classifyMouseEvent(button: number, final: 'M' | 'm'): TerminalMouseEventType {
  if ((button & MOUSE_WHEEL_BIT) !== 0) return 'other';
  const buttonId = button & MOUSE_BUTTON_MASK;
  const moving = (button & MOUSE_MOTION_BIT) !== 0;
  if (final === 'm') return buttonId === 0 || buttonId === 3 ? 'left-up' : 'other';
  if (buttonId === 3 && !moving) return 'left-up';
  if (buttonId !== 0) return 'other';
  return moving ? 'left-drag' : 'left-down';
}

export function parseSgrMouseEvent(data: string): TerminalMouseEvent | undefined {
  SGR_MOUSE_EVENT.lastIndex = 0;
  const match = SGR_MOUSE_EVENT.exec(data);
  if (match === null || match.index !== 0 || match[0].length !== data.length) return undefined;

  const button = Number(match[1]);
  const col = Number(match[2]);
  const row = Number(match[3]);
  const final = match[4] as 'M' | 'm';
  if (!Number.isInteger(button) || !Number.isInteger(col) || !Number.isInteger(row)) return undefined;
  if (col < 1 || row < 1) return undefined;
  return { type: classifyMouseEvent(button, final), button, col, row, final };
}

export function installTerminalMouseTracking(
  state: TerminalMouseTrackingState,
  onMouseEvent: (event: TerminalMouseEvent) => void,
): () => void {
  const disposeInputListener = state.ui.addInputListener((data) => {
    let remaining = '';
    let lastIndex = 0;
    let matched = false;
    SGR_MOUSE_EVENT.lastIndex = 0;

    for (const match of data.matchAll(SGR_MOUSE_EVENT)) {
      matched = true;
      remaining += data.slice(lastIndex, match.index);
      lastIndex = match.index + match[0].length;
      const event = parseSgrMouseEvent(match[0]);
      if (event !== undefined) onMouseEvent(event);
    }

    if (!matched) return undefined;
    remaining += data.slice(lastIndex);
    return remaining.length === 0 ? { consume: true } : { data: remaining };
  });
  state.terminal.write(ENABLE_TERMINAL_MOUSE_REPORTING);

  return () => {
    disposeInputListener();
    state.terminal.write(DISABLE_TERMINAL_MOUSE_REPORTING);
  };
}

export function installEditorMouseTracking(state: EditorMouseState): () => void {
  let dragActive = false;
  let lastAppliedPosition: EditorPosition | undefined;
  let pendingPosition: EditorPosition | undefined;
  let dragUpdateTimer: ReturnType<typeof setTimeout> | undefined;

  const samePosition = (a: EditorPosition | undefined, b: EditorPosition): boolean =>
    a?.line === b.line && a.col === b.col;

  const applyDragPosition = (position: EditorPosition): void => {
    if (samePosition(lastAppliedPosition, position)) return;
    lastAppliedPosition = position;
    state.editor.updateSelection(position);
  };

  const clearDragTimer = (): void => {
    if (dragUpdateTimer === undefined) return;
    clearTimeout(dragUpdateTimer);
    dragUpdateTimer = undefined;
  };

  const flushPendingDrag = (): void => {
    dragUpdateTimer = undefined;
    const position = pendingPosition;
    pendingPosition = undefined;
    if (!dragActive || position === undefined) return;
    applyDragPosition(position);
    dragUpdateTimer = setTimeout(flushPendingDrag, DRAG_UPDATE_INTERVAL_MS);
  };

  const queueDragPosition = (position: EditorPosition): void => {
    if (samePosition(lastAppliedPosition, position) || samePosition(pendingPosition, position)) return;
    if (dragUpdateTimer === undefined) {
      applyDragPosition(position);
      dragUpdateTimer = setTimeout(flushPendingDrag, DRAG_UPDATE_INTERVAL_MS);
      return;
    }
    pendingPosition = position;
  };

  const disposeTracking = installTerminalMouseTracking(state, (event) => {
    if (event.type === 'left-down') {
      const position = resolveEditorPosition(state, event, false);
      if (position === undefined) return;
      clearDragTimer();
      pendingPosition = undefined;
      dragActive = true;
      lastAppliedPosition = position;
      state.editor.beginSelection(position);
      return;
    }

    if (!dragActive) return;
    if (event.type === 'left-drag') {
      const position = resolveEditorPosition(state, event, true);
      if (position !== undefined) queueDragPosition(position);
      return;
    }

    if (event.type === 'left-up') {
      clearDragTimer();
      const position = resolveEditorPosition(state, event, true) ?? pendingPosition;
      pendingPosition = undefined;
      if (position !== undefined) applyDragPosition(position);
      state.editor.finishSelection();
      dragActive = false;
      lastAppliedPosition = undefined;
    }
  });

  return () => {
    clearDragTimer();
    pendingPosition = undefined;
    dragActive = false;
    lastAppliedPosition = undefined;
    disposeTracking();
  };
}

function resolveEditorPosition(
  state: EditorMouseState,
  event: TerminalMouseEvent,
  clamp: boolean,
): EditorPosition | undefined {
  const target = resolveEditorMouseTarget(state, event, clamp);
  if (target === undefined) return undefined;
  return state.editor.positionAtRenderedCell(target.row, target.col, clamp);
}

export function resolveEditorMouseTarget(
  state: EditorMouseState,
  event: Pick<TerminalMouseEvent, 'col' | 'row'>,
  clamp: boolean,
): EditorMouseTarget | undefined {
  if (!state.ui.children.includes(state.editorContainer)) return undefined;
  if (!state.editorContainer.children.includes(state.editor)) return undefined;

  const { columns: terminalWidth, rows: terminalRows } = state.terminal;
  if (terminalWidth < CHROME_GUTTER * 2 + 1 || terminalRows < 1) return undefined;
  if (!clamp && (event.col > terminalWidth || event.row > terminalRows)) return undefined;
  const layout = state.ui.getRenderedChildLayout(state.editorContainer);
  if (layout === undefined || layout.width !== terminalWidth) return undefined;

  const viewportTop = state.ui.getRenderedViewportTop();
  const screenRow = Math.max(0, Math.min(terminalRows - 1, event.row - 1));
  const logicalRow = viewportTop + screenRow;
  const editorWidth = Math.max(1, terminalWidth - CHROME_GUTTER * 2);
  if (editorWidth < 3) return undefined;
  const localRow = logicalRow - layout.startRow;
  const localCol = event.col - CHROME_GUTTER - 1;

  if (!clamp) {
    if (logicalRow < layout.startRow || logicalRow >= layout.endRow) return undefined;
    if (localCol < 1 || localCol >= editorWidth - 1) return undefined;
    return { row: localRow, col: localCol };
  }

  return {
    row: Math.max(0, Math.min(layout.endRow - layout.startRow - 1, localRow)),
    col: Math.max(1, Math.min(editorWidth - 2, localCol)),
  };
}
