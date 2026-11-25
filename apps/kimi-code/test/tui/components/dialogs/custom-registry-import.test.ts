import { CURSOR_MARKER, visibleWidth, type TuiMouseEvent } from '@moonshot-ai/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import {
  CustomRegistryImportDialogComponent,
  type CustomRegistryImportResult,
} from '#/tui/components/dialogs/custom-registry-import';
import { darkColors } from '#/tui/theme/colors';

const ANSI = /\[[0-9;]*m/g;
const strip = (s: string): string => s.replaceAll(ANSI, '');
const ESC = String.fromCodePoint(27);
const DOWN = `${ESC}[B`;
const UP = `${ESC}[A`;

function plain(component: CustomRegistryImportDialogComponent, width = 80): string {
  return component.render(width).map(strip).join('\n');
}

function makeDialog(defaultUrl = 'https://example.com/api.json'): {
  dialog: CustomRegistryImportDialogComponent;
  onDone: ReturnType<typeof vi.fn>;
} {
  const onDone = vi.fn();
  const dialog = new CustomRegistryImportDialogComponent(
    onDone as unknown as (r: CustomRegistryImportResult) => void,
    defaultUrl,
  );
  dialog.focused = true;
  return { dialog, onDone };
}

describe('CustomRegistryImportDialogComponent', () => {
  it('advances from the URL field to the token field on Enter instead of submitting', () => {
    const { dialog, onDone } = makeDialog();
    expect(plain(dialog)).toContain('next field');

    dialog.handleInput('\r');

    expect(onDone).not.toHaveBeenCalled();
    expect(plain(dialog)).toContain('Enter to submit');
  });

  it('switches fields with Up / Down arrows', () => {
    const { dialog } = makeDialog();
    dialog.handleInput(DOWN);
    expect(plain(dialog)).toContain('Enter to submit');
    dialog.handleInput(UP);
    expect(plain(dialog)).toContain('next field');
  });

  it('submits with an empty Bearer token for public registries', () => {
    const { dialog, onDone } = makeDialog();
    dialog.handleInput('\r');
    dialog.handleInput('\r');

    expect(onDone).toHaveBeenCalledWith({
      kind: 'ok',
      value: { url: 'https://example.com/api.json', apiKey: undefined },
    });
  });

  it('submits the url and token once both are provided', () => {
    const { dialog, onDone } = makeDialog();
    dialog.handleInput('\r');
    for (const ch of 'sk-tok') dialog.handleInput(ch);
    dialog.handleInput('\r');

    expect(onDone).toHaveBeenCalledWith({
      kind: 'ok',
      value: { url: 'https://example.com/api.json', apiKey: 'sk-tok' },
    });
  });

  it('keeps every line within narrow widths', () => {
    const { dialog } = makeDialog('https://example.com/very/long/registry/path.json');

    for (const width of [39, 35, 20, 10]) {
      for (const line of dialog.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('switches fields by clicking labels or inputs, syncs focus, and places cursors accurately', () => {
    const mouse = (
      type: TuiMouseEvent['type'],
      x: number,
      y: number,
      extra: { width?: number; wheelDelta?: number } = {},
    ): TuiMouseEvent => ({
      type,
      button: type === 'move' || type === 'wheel' ? 'none' : 'left',
      x,
      y,
      screenX: x,
      screenY: y,
      width: extra.width ?? 80,
      height: 17,
      shift: false,
      alt: false,
      ctrl: false,
      ...(extra.wheelDelta !== undefined ? { wheelDelta: extra.wheelDelta } : {}),
    });

    const { dialog, onDone } = makeDialog('https://example.com');
    dialog.focused = false;
    const rawUnfocused = dialog.render(80);
    expect(rawUnfocused[8]).not.toContain(CURSOR_MARKER);
    expect(rawUnfocused[11]).not.toContain(CURSOR_MARKER);
    expect(dialog.handleMouse(mouse('wheel', 5, 10, { wheelDelta: 1 }))).toBeUndefined();
    expect(dialog.handleMouse(mouse('press', 5, 10))).toEqual({ handled: true });
    expect(dialog.handleMouse(mouse('click', 5, 10))).toEqual({ handled: true, focus: true });
    expect(plain(dialog)).toContain('next field');

    dialog.focused = true;
    const rawUrlActive = dialog.render(80);
    expect(rawUrlActive[8]).toContain(CURSOR_MARKER);
    expect(rawUrlActive[11]).not.toContain(CURSOR_MARKER);
    expect(dialog.handleMouse(mouse('wheel', 5, 8, { wheelDelta: 1 }))).toEqual({ handled: true });

    expect(dialog.handleMouse(mouse('press', 5, 10))).toEqual({ handled: true, render: true });
    const rawTokenActive = dialog.render(80);
    expect(rawTokenActive[8]).not.toContain(CURSOR_MARKER);
    expect(rawTokenActive[11]).toContain(CURSOR_MARKER);
    expect(plain(dialog)).toContain('Enter to submit');
    for (const ch of 'abcd') dialog.handleInput(ch);
    dialog.render(80);

    expect(dialog.handleMouse(mouse('press', 7, 11))).toEqual({
      handled: true,
      focus: true,
      render: true,
    });
    dialog.handleInput('Z');

    expect(dialog.handleMouse(mouse('press', 5, 7))).toEqual({ handled: true, render: true });
    const rawBackToUrl = dialog.render(80);
    expect(rawBackToUrl[8]).toContain(CURSOR_MARKER);
    expect(rawBackToUrl[11]).not.toContain(CURSOR_MARKER);

    expect(dialog.handleMouse(mouse('press', 10, 8))).toEqual({
      handled: true,
      focus: true,
      render: true,
    });
    dialog.handleInput('X');

    dialog.handleInput('\r');
    dialog.handleInput('\r');
    expect(onDone).toHaveBeenCalledWith({
      kind: 'ok',
      value: { url: 'httpsX://example.com', apiKey: 'abZcd' },
    });
    expect(dialog.handleMouse(mouse('press', 5, 10))).toBeUndefined();

    const narrow = makeDialog('ab');
    narrow.dialog.render(3);
    expect(narrow.dialog.handleMouse(mouse('press', 0, 8, { width: 3 }))).toEqual({
      handled: true,
      render: true,
    });
    narrow.dialog.handleInput('tk');
    expect(narrow.dialog.handleMouse(mouse('press', 0, 6, { width: 3 }))).toEqual({
      handled: true,
      focus: true,
      render: true,
    });
    narrow.dialog.handleInput('!');
    narrow.dialog.handleInput('\r');
    narrow.dialog.handleInput('\r');
    expect(narrow.onDone).toHaveBeenCalledWith({
      kind: 'ok',
      value: { url: '!ab', apiKey: 'tk' },
    });
  });
});
