import type { TuiMouseEvent } from '@moonshot-ai/pi-tui';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import {
  UndoSelectorComponent,
  type UndoChoice,
} from '#/tui/components/dialogs/undo-selector';

const ESC = String.fromCodePoint(27);
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const PAGE_UP = `${ESC}[5~`;
const PAGE_DOWN = `${ESC}[6~`;
const ANSI = /\u001B\[[0-9;]*m/g;

function strip(line: string): string {
  return line.replaceAll(ANSI, '');
}

function makeChoices(count: number): UndoChoice[] {
  return Array.from({ length: count }, (_, idx) => ({
    id: `msg-${String(idx + 1)}`,
    count: count - idx,
    input: `prompt ${String(idx + 1)}`,
    label: `Message ${String(idx + 1)}`,
  }));
}

function mouseEvent(
  type: TuiMouseEvent['type'],
  y: number,
  wheelDelta?: number,
): TuiMouseEvent {
  return {
    type,
    button: type === 'move' || type === 'wheel' ? 'none' : 'left',
    x: 4,
    y,
    screenX: 4,
    screenY: y,
    width: 80,
    height: 20,
    shift: false,
    alt: false,
    ctrl: false,
    ...(wheelDelta !== undefined ? { wheelDelta } : {}),
  };
}

function useFakeDate(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

function visibleChoices(component: UndoSelectorComponent): string[] {
  return component
    .render(80)
    .map(strip)
    .filter((line) => line.includes('Message '));
}

describe('UndoSelectorComponent', () => {
  it('starts at the latest message and keeps the window stable on keyboard and hover moves', () => {
    const selector = new UndoSelectorComponent({
      choices: makeChoices(8),
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    selector.focused = true;

    const initialLines = selector.render(80).map(strip);
    const initialVisible = initialLines.filter((line) => line.includes('Message '));
    expect(initialVisible).toEqual([
      '    Message 4',
      '    Message 5',
      '    Message 6',
      '    Message 7',
      '  ❯ Message 8',
    ]);

    const firstRow = initialLines.findIndex((line) => line.includes('Message 4'));
    const lastRow = initialLines.findIndex((line) => line.includes('Message 8'));

    expect(selector.handleMouse(mouseEvent('move', firstRow))).toEqual({
      handled: true,
      render: true,
    });
    expect(visibleChoices(selector)).toEqual([
      '  ❯ Message 4',
      '    Message 5',
      '    Message 6',
      '    Message 7',
      '    Message 8',
    ]);

    expect(selector.handleMouse(mouseEvent('move', lastRow))).toEqual({
      handled: true,
      render: true,
    });
    expect(visibleChoices(selector)).toEqual([
      '    Message 4',
      '    Message 5',
      '    Message 6',
      '    Message 7',
      '  ❯ Message 8',
    ]);

    for (let i = 0; i < 4; i++) selector.handleInput(UP);
    expect(visibleChoices(selector)).toEqual([
      '  ❯ Message 4',
      '    Message 5',
      '    Message 6',
      '    Message 7',
      '    Message 8',
    ]);

    selector.handleInput(UP);
    expect(visibleChoices(selector)).toEqual([
      '  ❯ Message 3',
      '    Message 4',
      '    Message 5',
      '    Message 6',
      '    Message 7',
    ]);

    selector.handleInput(PAGE_UP);
    expect(visibleChoices(selector)).toEqual([
      '  ❯ Message 1',
      '    Message 2',
      '    Message 3',
      '    Message 4',
      '    Message 5',
    ]);

    selector.handleInput(PAGE_DOWN);
    expect(visibleChoices(selector)).toEqual([
      '    Message 2',
      '    Message 3',
      '    Message 4',
      '    Message 5',
      '  ❯ Message 6',
    ]);

    selector.handleInput(DOWN);
    expect(visibleChoices(selector)).toEqual([
      '    Message 3',
      '    Message 4',
      '    Message 5',
      '    Message 6',
      '  ❯ Message 7',
    ]);
  });

  it('scrolls smoothly with the mouse wheel, clamps selection into view, and consumes wheel at bounds', () => {
    const selector = new UndoSelectorComponent({
      choices: makeChoices(8),
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    selector.focused = true;
    selector.render(80);

    expect(selector.handleMouse(mouseEvent('wheel', 5, 1))).toEqual({
      handled: true,
      render: false,
    });

    expect(selector.handleMouse(mouseEvent('wheel', 5, -1))).toEqual({
      handled: true,
      render: true,
    });
    expect(visibleChoices(selector)).toEqual([
      '    Message 3',
      '    Message 4',
      '    Message 5',
      '    Message 6',
      '  ❯ Message 7',
    ]);

    expect(selector.handleMouse(mouseEvent('wheel', 5, -3))).toEqual({
      handled: true,
      render: true,
    });
    expect(visibleChoices(selector)).toEqual([
      '    Message 2',
      '    Message 3',
      '    Message 4',
      '    Message 5',
      '  ❯ Message 6',
    ]);

    const topRow = selector
      .render(80)
      .map(strip)
      .findIndex((line) => line.includes('Message 2'));
    selector.handleMouse(mouseEvent('move', topRow));
    expect(selector.handleMouse(mouseEvent('wheel', 5, 1))).toEqual({
      handled: true,
      render: true,
    });
    expect(visibleChoices(selector)).toEqual([
      '  ❯ Message 3',
      '    Message 4',
      '    Message 5',
      '    Message 6',
      '    Message 7',
    ]);
  });

  it('activates on left click once after settling, guards unfocused clicks, and ignores drag-off', () => {
    useFakeDate();
    const choices = makeChoices(6);
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const selector = new UndoSelectorComponent({ choices, onSelect, onCancel });
    const lines = selector.render(80).map(strip);
    const targetRow = lines.findIndex((line) => line.includes('Message 3'));
    const otherRow = lines.findIndex((line) => line.includes('Message 5'));

    expect(selector.handleMouse(mouseEvent('move', targetRow))).toBeUndefined();
    expect(selector.handleMouse(mouseEvent('wheel', targetRow, -1))).toBeUndefined();
    expect(selector.handleMouse(mouseEvent('press', targetRow))).toEqual({ handled: true });
    expect(selector.handleMouse(mouseEvent('click', targetRow))).toEqual({
      handled: true,
      focus: true,
    });
    expect(onSelect).not.toHaveBeenCalled();

    selector.focused = true;
    selector.handleMouse(mouseEvent('press', targetRow));
    selector.handleMouse(mouseEvent('click', targetRow));
    expect(onSelect).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    selector.handleMouse(mouseEvent('press', targetRow));
    selector.handleMouse(mouseEvent('click', otherRow));
    expect(onSelect).not.toHaveBeenCalled();

    selector.handleMouse(mouseEvent('press', targetRow));
    selector.handleMouse(mouseEvent('click', targetRow));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(choices[2]);

    expect(selector.handleMouse(mouseEvent('click', otherRow))).toBeUndefined();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('handles empty choice lists and Escape cleanly', () => {
    const onCancel = vi.fn();
    const selector = new UndoSelectorComponent({
      choices: [],
      onSelect: vi.fn(),
      onCancel,
    });
    selector.focused = true;
    const lines = selector.render(80).map(strip);
    expect(lines.join('\n')).toContain('No messages');
    expect(selector.handleMouse(mouseEvent('move', 4))).toBeUndefined();
    expect(selector.handleMouse(mouseEvent('click', 4))).toBeUndefined();
    expect(selector.handleMouse(mouseEvent('wheel', 4, -1))).toEqual({
      handled: true,
      render: false,
    });
    selector.handleInput(ESC);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
