import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
  TUI,
} from '@earendil-works/pi-tui';
import { Container, Spacer } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { CustomEditor } from '#/tui/components/editor/custom-editor';
import { GutterContainer } from '#/tui/components/chrome/gutter-container';
import { CHROME_GUTTER } from '#/tui/constant/rendering';
import { getColorPalette } from '#/tui/theme/index';
import type { TUIState } from '#/tui/kimi-tui';
import { resolveEditorMouseTarget } from '#/tui/utils/editor-mouse';

function makeEditor(): CustomEditor {
  const tui = {
    requestRender: vi.fn(),
    terminal: {
      columns: 80,
      rows: 24,
    },
  } as unknown as TUI;
  return new CustomEditor(tui, { ...getColorPalette('dark') });
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

describe('CustomEditor Kitty key release handling', () => {
  it('ignores Kitty key release events instead of inserting their CSI-u payload', () => {
    const editor = makeEditor();

    editor.handleInput('\u001B[47;1:3u');
    editor.handleInput('\u001B[110;1:3u');

    expect(editor.getText()).toBe('');
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

    editor.handleInput('\x16');

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

describe('CustomEditor mouse cursor positioning', () => {
  it('moves the cursor to the clicked column on a single-line prompt', () => {
    const editor = makeEditor();
    editor.setText('hello world');

    expect(editor.moveCursorToMousePosition(1, 10, 40)).toBe(true);
    expect(editor.getCursor()).toEqual({ line: 0, col: 6 });

    editor.handleInput('X');
    expect(editor.getText()).toBe('hello Xworld');
  });

  it('maps prompt clicks to line start and right-padding clicks to line end', () => {
    const editor = makeEditor();
    editor.setText('abc');

    expect(editor.moveCursorToMousePosition(1, 2, 24)).toBe(true);
    expect(editor.getCursor()).toEqual({ line: 0, col: 0 });

    expect(editor.moveCursorToMousePosition(1, 20, 24)).toBe(true);
    expect(editor.getCursor()).toEqual({ line: 0, col: 3 });
  });

  it('moves across logical lines', () => {
    const editor = makeEditor();
    editor.setText('one\ntwo');

    expect(editor.moveCursorToMousePosition(2, 5, 40)).toBe(true);
    expect(editor.getCursor()).toEqual({ line: 1, col: 1 });
  });

  it('maps clicks on wrapped visual lines back to logical columns', () => {
    const editor = makeEditor();
    editor.setText('abcdefghij');

    expect(editor.moveCursorToMousePosition(2, 5, 16)).toBe(true);
    expect(editor.getCursor()).toEqual({ line: 0, col: 9 });
  });

  it('resolves terminal mouse coordinates through the editor container gutter', () => {
    const editor = makeEditor();
    const ui = new Container();
    const transcript = new Container();
    const editorContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
    transcript.addChild(new Spacer(2));
    editorContainer.addChild(editor);
    ui.addChild(transcript);
    ui.addChild(editorContainer);

    const state = {
      ui,
      editor,
      editorContainer,
      terminal: {
        columns: 40,
        rows: 20,
      },
    } as unknown as TUIState;

    expect(
      resolveEditorMouseTarget(state, {
        button: 0,
        col: CHROME_GUTTER + 6 + 1,
        row: 19,
        final: 'M',
      }),
    ).toEqual({ row: 1, col: 6, width: 38 });
  });
});
