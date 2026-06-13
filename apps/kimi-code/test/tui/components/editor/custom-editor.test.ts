import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
  TUI,
} from '@earendil-works/pi-tui';
import { CURSOR_MARKER } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import {
  CustomEditor,
  removeFakeCursorAtHardwareMarker,
} from '#/tui/components/editor/custom-editor';

function makeEditor(): CustomEditor {
  const tui = {
    requestRender: vi.fn(),
    terminal: { rows: 40, cols: 120 },
  } as unknown as TUI;
  return new CustomEditor(tui);
}

async function flushAutocomplete(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function providerReturning(items: AutocompleteItem[]): AutocompleteProvider {
  return {
    getSuggestions: vi.fn(async () => ({ items, prefix: '/' })),
    applyCompletion: vi.fn((lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol })),
  };
}

describe('CustomEditor autocomplete Escape handling', () => {
  it('escape closes a visible slash command menu without firing app-level escape', async () => {
    const editor = makeEditor();
    const onEscape = vi.fn();
    editor.onEscape = onEscape;
    editor.setAutocompleteProvider(providerReturning([{ value: 'help', label: 'help' }]));

    editor.handleInput('/');
    await flushAutocomplete();

    expect(editor.isShowingAutocomplete()).toBe(true);

    editor.handleInput('\u001B');

    expect(editor.isShowingAutocomplete()).toBe(false);
    expect(onEscape).not.toHaveBeenCalled();
  });

  it('escape cancels an in-flight slash command menu request', async () => {
    const editor = makeEditor();
    const onEscape = vi.fn();
    let resolveSuggestions: (items: AutocompleteItem[]) => void = () => {};
    const provider: AutocompleteProvider = {
      getSuggestions: vi.fn(
        () =>
          new Promise<AutocompleteSuggestions | null>((resolve) => {
            resolveSuggestions = (items) =>{  resolve({ items, prefix: '/' }); };
          }),
      ),
      applyCompletion: vi.fn((lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol })),
    };
    editor.onEscape = onEscape;
    editor.setAutocompleteProvider(provider);

    editor.handleInput('/');
    await flushAutocomplete();
    editor.handleInput('\u001B');
    resolveSuggestions([{ value: 'help', label: 'help' }]);
    await flushAutocomplete();

    expect(editor.isShowingAutocomplete()).toBe(false);
    expect(onEscape).not.toHaveBeenCalled();
  });
});

describe('CustomEditor slash menu description wrapping', () => {
  // oxlint-disable-next-line no-control-regex -- ESC (\x1b) is required to match ANSI SGR escape sequences
  const stripAnsi = (s: string): string => s.replaceAll(/\u001B\[[0-9;]*m/g, '');

  it('wraps long slash command descriptions to at most two lines with an ellipsis', async () => {
    const editor = makeEditor();
    const description = 'word '.repeat(60).trim();
    editor.setAutocompleteProvider(
      providerReturning([{ value: 'deep', label: 'deep', description }]),
    );

    editor.handleInput('/');
    await flushAutocomplete();

    const plain = editor.render(90).map(stripAnsi);
    const descriptionLines = plain.filter((line) => line.includes('word'));
    expect(descriptionLines).toHaveLength(2);
    expect(descriptionLines[1]).toContain('…');
  });

  it('keeps non-slash autocomplete descriptions on a single line', async () => {
    const editor = makeEditor();
    const description = 'path '.repeat(60).trim();
    const provider: AutocompleteProvider = {
      getSuggestions: vi.fn(async () => ({
        items: [{ value: '@src/file.ts', label: 'file.ts', description }],
        prefix: '@f',
      })),
      applyCompletion: vi.fn((lines, cursorLine, cursorCol) => ({
        lines,
        cursorLine,
        cursorCol,
      })),
    };
    editor.setAutocompleteProvider(provider);

    editor.handleInput('@');
    // @-mention requests are debounced (20ms), unlike slash menus.
    await new Promise((resolve) => setTimeout(resolve, 30));
    await flushAutocomplete();

    const plain = editor.render(90).map(stripAnsi);
    const descriptionLines = plain.filter((line) => line.includes('path'));
    expect(descriptionLines).toHaveLength(1);
    expect(plain.join('\n')).not.toContain('…');
  });
});

describe('CustomEditor Kitty key release handling', () => {
  it('ignores Kitty key release events instead of inserting their CSI-u payload', () => {
    const editor = makeEditor();

    editor.handleInput('\u001B[47;1:3u');
    editor.handleInput('\u001B[110;1:3u');

    expect(editor.getText()).toBe('');
  });
});

describe('removeFakeCursorAtHardwareMarker', () => {
  it('removes the rendered fake cursor and keeps the hardware cursor marker in place', () => {
    const line = `before${CURSOR_MARKER}\u001B[7m \u001B[0mafter`;

    expect(removeFakeCursorAtHardwareMarker(line)).toBe(`before${CURSOR_MARKER} after`);
  });

  it('renders a focused editor with hardware cursor positioning but no fake cursor block', () => {
    const editor = makeEditor();
    editor.focused = true;
    editor.setText('test');

    const output = editor.render(40).join('\n');

    expect(output).toContain(CURSOR_MARKER);
    expect(output).not.toContain('\u001B[7m');
  });

  it('leaves unrelated marker-like lines untouched', () => {
    const line = `before${CURSOR_MARKER}after`;

    expect(removeFakeCursorAtHardwareMarker(line)).toBe(line);
  });
});

describe('CustomEditor paste marker expansion', () => {
  const PASTE_START = '\x1b[200~';
  const PASTE_END = '\x1b[201~';

  function simulateLargePaste(editor: CustomEditor, content: string): void {
    editor.handleInput(`${PASTE_START}${content}${PASTE_END}`);
  }

  it('expands paste marker when bracketed paste arrives while cursor is on marker', () => {
    const editor = makeEditor();
    const longText = 'line\n'.repeat(15).trimEnd();
    simulateLargePaste(editor, longText);

    expect(editor.getText()).toMatch(/\[paste #1 \+15 lines\]/);

    simulateLargePaste(editor, 'anything');

    expect(editor.getText()).not.toContain('[paste #');
    expect(editor.getText()).toContain(longText);
  });

  it('does not expand when cursor is not on a paste marker', () => {
    const editor = makeEditor();
    const longText = 'line\n'.repeat(15).trimEnd();
    simulateLargePaste(editor, longText);

    editor.handleInput('hello');

    const textBefore = editor.getText();
    expect(textBefore).toContain('[paste #1');
    expect(textBefore).toContain('hello');

    const anotherLong = 'other\n'.repeat(15).trimEnd();
    simulateLargePaste(editor, anotherLong);

    expect(editor.getText()).toContain('[paste #1');
    expect(editor.getText()).toContain('[paste #2');
  });

  it('expands only the marker under cursor when multiple markers exist', () => {
    const editor = makeEditor();
    const text1 = 'first\n'.repeat(15).trimEnd();
    const text2 = 'second\n'.repeat(15).trimEnd();
    simulateLargePaste(editor, text1);
    editor.handleInput(' ');
    simulateLargePaste(editor, text2);

    expect(editor.getText()).toContain('[paste #1');
    expect(editor.getText()).toContain('[paste #2');

    editor.setText('[paste #1 +15 lines] [paste #2 +15 lines]');

    simulateLargePaste(editor, 'anything');

    expect(editor.getText()).toContain('[paste #1');
    expect(editor.getText()).not.toContain('[paste #2');
    expect(editor.getText()).toContain(text2);
  });

  it('handles Ctrl+V expansion when cursor is on marker', () => {
    const editor = makeEditor();
    editor.onPasteImage = vi.fn(async () => false);
    const longText = 'line\n'.repeat(15).trimEnd();
    simulateLargePaste(editor, longText);

    expect(editor.getText()).toMatch(/\[paste #1/);

    editor.handleInput(process.platform === 'win32' ? '\x1b[118;3u' : '\x16');

    expect(editor.getText()).not.toContain('[paste #');
    expect(editor.getText()).toContain(longText);
  });

  it('can re-expand after undo restores the marker', () => {
    const editor = makeEditor();
    const longText = 'line\n'.repeat(15).trimEnd();
    simulateLargePaste(editor, longText);

    const markerText = editor.getText();
    expect(markerText).toMatch(/\[paste #1/);

    simulateLargePaste(editor, 'anything');
    expect(editor.getText()).toContain(longText);

    editor.setText(markerText);

    simulateLargePaste(editor, 'anything');
    expect(editor.getText()).not.toContain('[paste #');
    expect(editor.getText()).toContain(longText);
  });

  it('suppresses multi-chunk bracketed paste data after marker expansion', () => {
    const editor = makeEditor();
    const longText = 'line\n'.repeat(15).trimEnd();
    simulateLargePaste(editor, longText);

    editor.handleInput(`${PASTE_START}chunk1`);
    editor.handleInput(`chunk2${PASTE_END}`);

    expect(editor.getText()).not.toContain('chunk1');
    expect(editor.getText()).not.toContain('chunk2');
    expect(editor.getText()).toContain(longText);
  });

  it('handles paste-end sequence split across chunks', () => {
    const editor = makeEditor();
    const longText = 'line\n'.repeat(15).trimEnd();
    simulateLargePaste(editor, longText);

    // Split: PASTE_START in chunk 1, paste-end split across chunk 2 and 3
    editor.handleInput(`${PASTE_START}data`);
    editor.handleInput('\x1b[20');
    editor.handleInput('1~');

    expect(editor.getText()).toContain(longText);
    expect(editor.getText()).not.toContain('data');

    // Verify editor is not stuck — next keystrokes should work normally
    editor.handleInput('x');
    expect(editor.getText()).toContain('x');
  });
});

describe('CustomEditor shortcut telemetry hooks', () => {
  it('reports newline shortcuts, including Ctrl-J, before delegating to the base editor', () => {
    const editor = makeEditor();
    const onInsertNewline = vi.fn();
    editor.onInsertNewline = onInsertNewline;

    editor.handleInput('a');
    editor.handleInput('\n');
    editor.handleInput('\u001B[106;5u');

    expect(onInsertNewline).toHaveBeenCalledTimes(2);
    expect(editor.getText()).toBe('a\n\n');
  });

  it('reports undo shortcuts before delegating to the base editor', () => {
    const editor = makeEditor();
    const onUndo = vi.fn();
    editor.onUndo = onUndo;

    editor.handleInput('a');
    editor.handleInput('\u001F');

    expect(onUndo).toHaveBeenCalledOnce();
  });
});
