import { stripVTControlCharacters } from 'node:util';

import { visibleWidth, type TuiMouseEvent } from '@moonshot-ai/pi-tui';
import { describe, expect, it } from 'vitest';

import { ApiKeyInputDialogComponent } from '#/tui/components/dialogs/api-key-input-dialog';

function mouse(
  type: TuiMouseEvent['type'],
  x: number,
  y: number,
  extra: Partial<TuiMouseEvent> = {},
): TuiMouseEvent {
  return {
    type,
    button: extra.button ?? (type === 'move' || type === 'wheel' ? 'none' : 'left'),
    x,
    y,
    screenX: x,
    screenY: y,
    width: extra.width ?? 60,
    height: extra.height ?? 16,
    shift: false,
    alt: false,
    ctrl: false,
    ...(extra.wheelDelta !== undefined ? { wheelDelta: extra.wheelDelta } : {}),
  };
}

describe('ApiKeyInputDialogComponent', () => {
  it('keeps every line within narrow widths', () => {
    const dialog = new ApiKeyInputDialogComponent(
      'Kimi Code',
      ['Paste your API key below.', 'It will be stored locally.'],
      () => {},
    );
    dialog.focused = true;

    for (const width of [39, 20, 10]) {
      for (const line of dialog.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('preserves password whitespace when trimming is disabled', () => {
    let submitted: string | undefined;
    const dialog = new ApiKeyInputDialogComponent(
      'dev-box',
      ['Password'],
      (result) => {
        if (result.kind === 'ok') submitted = result.value;
      },
      { trimValue: false },
    );
    dialog.handleInput(' secret ');
    dialog.handleInput('\r');
    expect(submitted).toBe(' secret ');
  });

  it('does not convert trailing layout padding into password bullets', () => {
    const dialog = new ApiKeyInputDialogComponent('dev-box', [], () => {});
    dialog.handleInput('smoke-password');
    const rendered = dialog.render(60).join('\n');
    expect(rendered).not.toContain('smoke-password');
    expect(rendered.match(/•/g)).toHaveLength(14);
  });

  it('focuses on unfocused click, consumes wheel, and places cursor at exact columns', () => {
    let submitted: string | undefined;
    const dialog = new ApiKeyInputDialogComponent(
      'Kimi Code',
      ['Line 1', 'Line 2'],
      (result) => {
        if (result.kind === 'ok') submitted = result.value;
      },
      { mask: false },
    );
    dialog.handleInput('abcdef');

    const lines = dialog.render(60).map((line) => stripVTControlCharacters(line));
    const inputRow = lines.findIndex((line) => line.includes('> abcdef'));
    expect(inputRow).toBe(8);
    expect(lines[inputRow]?.indexOf('abcdef')).toBe(5);

    expect(dialog.handleMouse(mouse('wheel', 7, inputRow, { wheelDelta: 1 }))).toBeUndefined();
    expect(dialog.handleMouse(mouse('press', 7, inputRow))).toEqual({ handled: true });
    expect(dialog.handleMouse(mouse('click', 7, inputRow))).toEqual({ handled: true, focus: true });

    dialog.focused = true;
    dialog.render(60);
    expect(dialog.handleMouse(mouse('wheel', 7, inputRow, { wheelDelta: 1 }))).toEqual({
      handled: true,
    });
    expect(dialog.handleMouse(mouse('press', 7, inputRow))).toEqual({
      handled: true,
      focus: true,
      render: true,
    });
    dialog.handleInput('X');

    expect(dialog.handleMouse(mouse('press', 5, inputRow))).toEqual({
      handled: true,
      focus: true,
      render: true,
    });
    dialog.handleInput('Z');

    dialog.handleInput('\r');
    expect(submitted).toBe('ZabXcdef');
    expect(dialog.handleMouse(mouse('press', 5, inputRow))).toBeUndefined();
  });

  it('tracks dynamic empty-hint row shifts and narrow widths for mouse placement', () => {
    let submitted: string | undefined;
    const dialog = new ApiKeyInputDialogComponent('Kimi Code', [], (result) => {
      if (result.kind === 'ok') submitted = result.value;
    });
    dialog.focused = true;

    const initialRow = dialog
      .render(60)
      .map((line) => stripVTControlCharacters(line))
      .findIndex((line) => line.includes('> '));
    expect(initialRow).toBe(6);

    dialog.handleInput('\r');
    const shiftedRow = dialog
      .render(60)
      .map((line) => stripVTControlCharacters(line))
      .findIndex((line) => line.includes('> '));
    expect(shiftedRow).toBe(7);

    dialog.handleInput('ab');
    const maskedRow = dialog
      .render(60)
      .map((line) => stripVTControlCharacters(line))
      .findIndex((line) => line.includes('> •'));
    expect(maskedRow).toBe(6);

    expect(dialog.handleMouse(mouse('press', 6, maskedRow))).toEqual({
      handled: true,
      focus: true,
      render: true,
    });
    dialog.handleInput('!');
    dialog.handleInput('\r');
    expect(submitted).toBe('a!b');

    let narrowSubmitted: string | undefined;
    const narrow = new ApiKeyInputDialogComponent('Kimi Code', ['Hint'], (result) => {
      if (result.kind === 'ok') narrowSubmitted = result.value;
    });
    narrow.focused = true;
    narrow.handleInput('ab');
    const narrowLines = narrow.render(3).map((line) => stripVTControlCharacters(line));
    const narrowRow = narrowLines.findIndex((line) => line.startsWith('>'));
    expect(narrowRow).toBe(5);
    expect(narrow.handleMouse(mouse('press', 0, narrowRow, { width: 3 }))).toEqual({
      handled: true,
      focus: true,
      render: true,
    });
    narrow.handleInput('X');
    narrow.handleInput('\r');
    expect(narrowSubmitted).toBe('Xab');
  });
});
