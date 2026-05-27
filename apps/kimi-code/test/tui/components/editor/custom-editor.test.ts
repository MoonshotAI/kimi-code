import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
  TUI,
} from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { CustomEditor } from '#/tui/components/editor/custom-editor';
import { getColorPalette } from '#/tui/theme/index';

function makeEditor(): CustomEditor {
  const tui = {
    requestRender: vi.fn(),
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
