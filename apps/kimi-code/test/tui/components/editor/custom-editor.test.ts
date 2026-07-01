import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
  TUI,
} from '@moonshot-ai/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { CustomEditor } from '#/tui/components/editor/custom-editor';
import { FileMentionProvider } from '#/tui/components/editor/file-mention-provider';

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

function providerRecordingForce(items: AutocompleteItem[]): {
  provider: AutocompleteProvider;
  calls: Array<{ force: boolean | undefined; text: string }>;
} {
  const calls: Array<{ force: boolean | undefined; text: string }> = [];
  const provider: AutocompleteProvider = {
    getSuggestions: vi.fn(async (lines, cursorLine, cursorCol, options) => {
      const text = (lines[cursorLine] ?? '').slice(0, cursorCol);
      calls.push({ force: options?.force, text });
      return { items, prefix: text };
    }),
    applyCompletion: vi.fn((lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol })),
  };
  return { provider, calls };
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

describe('CustomEditor onNonEscapeInput', () => {
  it('fires for a printable key and not for a lone Escape', () => {
    const editor = makeEditor();
    const onNonEscapeInput = vi.fn();
    editor.onNonEscapeInput = onNonEscapeInput;

    editor.handleInput('a');
    expect(onNonEscapeInput).toHaveBeenCalledOnce();

    editor.handleInput('\u001B');
    expect(onNonEscapeInput).toHaveBeenCalledOnce();
  });

  it('fires for control keys so they break a pending double-Esc', () => {
    const editor = makeEditor();
    const onNonEscapeInput = vi.fn();
    editor.onNonEscapeInput = onNonEscapeInput;

    editor.handleInput('\u0003');
    expect(onNonEscapeInput).toHaveBeenCalledOnce();
  });
});

describe('CustomEditor slash argument completion refresh', () => {
  it('reopens /add-dir directory completions after tab completion and entering slash', async () => {
    const editor = makeEditor();
    const provider = new FileMentionProvider(
      [
        {
          name: 'add-dir',
          description: 'Add directory',
          getArgumentCompletions: (prefix) =>
            prefix === '/' ? [{ value: '/tmp/shared/', label: 'shared/' }] : null,
        },
      ],
      process.cwd(),
      null,
    );
    editor.setAutocompleteProvider(provider);

    for (const char of '/add-dir ') {
      editor.handleInput(char);
    }
    await flushAutocomplete();

    editor.handleInput('/');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await flushAutocomplete();

    expect(editor.getText()).toBe('/add-dir /');
    expect(editor.isShowingAutocomplete()).toBe(true);
  });

  it('reopens the next directory level after tab-accepting a directory', async () => {
    const editor = makeEditor();
    const provider = new FileMentionProvider(
      [
        {
          name: 'add-dir',
          description: 'Add directory',
          getArgumentCompletions: (prefix) => {
            if (prefix === '/') return [{ value: '/tmp/shared/', label: 'shared/' }];
            if (prefix === '/tmp/shared/') return [{ value: '/tmp/shared/child/', label: 'child/' }];
            return null;
          },
        },
      ],
      process.cwd(),
      null,
    );
    editor.setAutocompleteProvider(provider);

    for (const char of '/add-dir ') {
      editor.handleInput(char);
    }
    await flushAutocomplete();

    editor.handleInput('/');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await flushAutocomplete();
    expect(editor.isShowingAutocomplete()).toBe(true);

    editor.handleInput('\t');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await flushAutocomplete();

    expect(editor.getText()).toBe('/add-dir /tmp/shared/');
    expect(editor.isShowingAutocomplete()).toBe(true);
  });
});

describe('CustomEditor slash command name Tab-accept', () => {
  it('reopens subcommand completions after Tab-accepting a slash command name', async () => {
    const editor = makeEditor();
    const provider = new FileMentionProvider(
      [
        {
          name: 'goal',
          description: 'Manage goals',
          getArgumentCompletions: (prefix) =>
            prefix === ''
              ? [
                  { value: 'status', label: 'status' },
                  { value: 'pause', label: 'pause' },
                ]
              : null,
        },
      ],
      process.cwd(),
      null,
    );
    editor.setAutocompleteProvider(provider);

    for (const char of '/go') {
      editor.handleInput(char);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    await flushAutocomplete();
    expect(editor.isShowingAutocomplete()).toBe(true);

    editor.handleInput('\t');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await flushAutocomplete();

    expect(editor.getText()).toBe('/goal ');
    expect(editor.isShowingAutocomplete()).toBe(true);
  });

  it('does not fall back to file completions for a command without subcommands', async () => {
    const editor = makeEditor();
    const provider = new FileMentionProvider(
      [
        {
          name: 'compact',
          description: 'Compact context',
        },
      ],
      process.cwd(),
      null,
    );
    editor.setAutocompleteProvider(provider);

    for (const char of '/comp') {
      editor.handleInput(char);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    await flushAutocomplete();
    expect(editor.isShowingAutocomplete()).toBe(true);

    editor.handleInput('\t');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await flushAutocomplete();

    expect(editor.getText()).toBe('/compact ');
    expect(editor.isShowingAutocomplete()).toBe(false);
  });
});

describe('CustomEditor @ mention completion refresh', () => {
  it('reopens the next directory level after tab-accepting an @ directory', async () => {
    const editor = makeEditor();
    const provider: AutocompleteProvider = {
      getSuggestions: vi.fn(
        async (
          lines: string[],
          cursorLine: number,
          cursorCol: number,
        ): Promise<AutocompleteSuggestions> => {
          const text = (lines[cursorLine] ?? '').slice(0, cursorCol);
          if (text === '@') {
            return { items: [{ value: '@shared/', label: 'shared/' }], prefix: '@' };
          }
          if (text === '@shared/') {
            return { items: [{ value: '@shared/child/', label: 'child/' }], prefix: '@shared/' };
          }
          return { items: [], prefix: '' };
        },
      ),
      applyCompletion: vi.fn(
        (
          lines: string[],
          cursorLine: number,
          cursorCol: number,
          item: AutocompleteItem,
          prefix: string,
        ) => {
          const line = lines[cursorLine] ?? '';
          const beforePrefix = line.slice(0, cursorCol - prefix.length);
          const afterCursor = line.slice(cursorCol);
          const newLine = beforePrefix + item.value + afterCursor;
          const newLines = [...lines];
          newLines[cursorLine] = newLine;
          return {
            lines: newLines,
            cursorLine,
            cursorCol: beforePrefix.length + item.value.length,
          };
        },
      ),
    };
    editor.setAutocompleteProvider(provider);

    editor.handleInput('@');
    await new Promise((resolve) => setTimeout(resolve, 30));
    await flushAutocomplete();
    expect(editor.isShowingAutocomplete()).toBe(true);

    editor.handleInput('\t');
    await new Promise((resolve) => setTimeout(resolve, 30));
    await flushAutocomplete();

    expect(editor.getText()).toBe('@shared/');
    expect(editor.isShowingAutocomplete()).toBe(true);
  });
});

describe('CustomEditor Tab key handling', () => {
  it('does not open autocomplete when Tab is pressed with the dropdown closed', async () => {
    const editor = makeEditor();
    const provider = providerReturning([{ value: '@src/file.ts', label: 'file.ts' }]);
    editor.setAutocompleteProvider(provider);

    editor.handleInput('\t');
    await new Promise((resolve) => setTimeout(resolve, 30));
    await flushAutocomplete();

    expect(provider.getSuggestions).not.toHaveBeenCalled();
    expect(editor.isShowingAutocomplete()).toBe(false);
  });
});

describe('CustomEditor slash argument hint', () => {
  // oxlint-disable-next-line no-control-regex -- ESC (\u001B) is required to match ANSI SGR escape sequences
  const stripAnsi = (s: string): string => s.replaceAll(/\u001B\[[0-9;]*m/g, '');

  it('renders the argument hint after a command with a trailing space', () => {
    const editor = makeEditor();
    editor.setArgumentHints(new Map([['add-dir', '[list] | <path>']]));

    for (const char of '/add-dir ') {
      editor.handleInput(char);
    }

    const plain = editor.render(90).map(stripAnsi).join('\n');
    expect(plain).toContain('[list] | <path>');
  });

  it('renders the argument hint after a command without a trailing space', () => {
    const editor = makeEditor();
    editor.setArgumentHints(new Map([['add-dir', '[list] | <path>']]));

    for (const char of '/add-dir') {
      editor.handleInput(char);
    }

    const plain = editor.render(90).map(stripAnsi).join('\n');
    expect(plain).toContain('[list] | <path>');
  });

  it('hides the hint once an argument is typed', () => {
    const editor = makeEditor();
    editor.setArgumentHints(new Map([['add-dir', '[list] | <path>']]));

    for (const char of '/add-dir foo') {
      editor.handleInput(char);
    }

    const plain = editor.render(90).map(stripAnsi).join('\n');
    expect(plain).not.toContain('[list] | <path>');
  });

  it('does not render a hint for an unknown command', () => {
    const editor = makeEditor();
    editor.setArgumentHints(new Map([['add-dir', '[list] | <path>']]));

    for (const char of '/unknown ') {
      editor.handleInput(char);
    }

    const plain = editor.render(90).map(stripAnsi).join('\n');
    expect(plain).not.toContain('[list] | <path>');
  });

  it('does not render the argument hint in bash mode', () => {
    const editor = makeEditor();
    editor.setArgumentHints(new Map([['add-dir', '[list] | <path>']]));
    editor.inputMode = 'bash';

    for (const char of '/add-dir') {
      editor.handleInput(char);
    }

    const plain = editor.render(90).map(stripAnsi).join('\n');
    expect(plain).not.toContain('[list] | <path>');
  });

  it('does not highlight the slash token in bash mode', () => {
    const editor = makeEditor();
    editor.inputMode = 'bash';

    for (const char of '/add-dir') {
      editor.handleInput(char);
    }

    const contentLine = editor.render(90)[1] ?? '';
    const tokenIdx = contentLine.indexOf('/add-dir');
    expect(tokenIdx).toBeGreaterThan(-1);
    // Prompt mode wraps `/add-dir` in a primary-colour ANSI sequence; in bash
    // mode the token is plain text, so the byte right before it is a space.
    expect(contentLine[tokenIdx - 1]).toBe(' ');
  });
});

describe('CustomEditor slash menu description wrapping', () => {
  // oxlint-disable-next-line no-control-regex -- ESC (\u001B) is required to match ANSI SGR escape sequences
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

describe('CustomEditor paste marker expansion', () => {
  const PASTE_START = '\u001B[200~';
  const PASTE_END = '\u001B[201~';

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

    editor.handleInput(process.platform === 'win32' ? '\u001Bv' : '\u0016');

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
    editor.handleInput('\u001B[20');
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

  it('invokes onToggleTodoExpand on Ctrl+T', () => {
    const editor = makeEditor();
    const onToggleTodoExpand = vi.fn().mockReturnValue(true);
    editor.onToggleTodoExpand = onToggleTodoExpand;

    editor.handleInput('\u0014');

    expect(onToggleTodoExpand).toHaveBeenCalledOnce();
  });
});

describe('CustomEditor bash mode border label', () => {
  // oxlint-disable-next-line no-control-regex -- ESC (\u001B) is required to match ANSI SGR escape sequences
  const stripAnsi = (s: string): string => s.replaceAll(/\u001B\[[0-9;]*m/g, '');

  it('shows "! shell mode" on the top border in bash mode', () => {
    const editor = makeEditor();
    editor.inputMode = 'bash';
    const top = stripAnsi(editor.render(90)[0] ?? '');
    expect(top.startsWith('╭')).toBe(true);
    expect(top).toContain('! shell mode');
    expect(top.endsWith('╮')).toBe(true);
  });

  it('does not show the shell mode label in prompt mode', () => {
    const editor = makeEditor();
    const top = stripAnsi(editor.render(90)[0] ?? '');
    expect(top).not.toContain('! shell mode');
  });

  it('keeps the top border at full width when the label is present', () => {
    const editor = makeEditor();
    editor.inputMode = 'bash';
    const width = 90;
    const top = stripAnsi(editor.render(width)[0] ?? '');
    expect(top).toHaveLength(width);
  });
});

describe('CustomEditor bash mode via paste', () => {
  const PASTE_START = '\u001B[200~';
  const PASTE_END = '\u001B[201~';

  it('enters bash mode and strips the leading ! when !cmd is pasted into an empty prompt', () => {
    const editor = makeEditor();
    const modes: Array<'prompt' | 'bash'> = [];
    editor.onInputModeChange = (mode) => modes.push(mode);

    editor.handleInput(`${PASTE_START}!ls${PASTE_END}`);

    expect(editor.inputMode).toBe('bash');
    expect(editor.getText()).toBe('ls');
    expect(modes).toEqual(['bash']);
  });

  it('enters bash mode on a bare pasted ! with an empty buffer', () => {
    const editor = makeEditor();
    editor.handleInput(`${PASTE_START}!${PASTE_END}`);

    expect(editor.inputMode).toBe('bash');
    expect(editor.getText()).toBe('');
  });

  it('does not enter bash mode when pasting !cmd into a non-empty prompt', () => {
    const editor = makeEditor();
    editor.handleInput('hello');
    editor.handleInput(`${PASTE_START}!ls${PASTE_END}`);

    expect(editor.inputMode).toBe('prompt');
    expect(editor.getText()).toContain('hello');
    expect(editor.getText()).toContain('!ls');
  });

  it('does not enter bash mode for a pasted command without a leading !', () => {
    const editor = makeEditor();
    editor.handleInput(`${PASTE_START}ls${PASTE_END}`);

    expect(editor.inputMode).toBe('prompt');
    expect(editor.getText()).toBe('ls');
  });

  it('keeps the typed ! behaviour (bash mode, empty buffer)', () => {
    const editor = makeEditor();
    editor.handleInput('!');

    expect(editor.inputMode).toBe('bash');
    expect(editor.getText()).toBe('');
  });

  it('enters bash mode on a CSI-u encoded ! keystroke (Kitty/VSCode terminals)', () => {
    const editor = makeEditor();
    editor.handleInput('\u001B[33u');

    expect(editor.inputMode).toBe('bash');
    expect(editor.getText()).toBe('');
  });
});

describe('CustomEditor bash mode file completion', () => {
  it('triggers file completion (force:true) for a leading / in bash mode, not the slash menu', async () => {
    const editor = makeEditor();
    const { provider, calls } = providerRecordingForce([{ value: 'auto', label: 'auto' }]);
    editor.setAutocompleteProvider(provider);
    editor.inputMode = 'bash';

    editor.handleInput('/');
    await flushAutocomplete();

    expect(calls).toContainEqual(expect.objectContaining({ force: true, text: '/' }));
    expect(editor.isShowingAutocomplete()).toBe(true);
  });

  it('triggers file completion (force:true) for an inline / in bash mode', async () => {
    const editor = makeEditor();
    const { provider, calls } = providerRecordingForce([{ value: 'etc', label: 'etc' }]);
    editor.setAutocompleteProvider(provider);
    editor.inputMode = 'bash';

    for (const char of 'ls /') {
      editor.handleInput(char);
    }
    await flushAutocomplete();

    expect(calls).toContainEqual(expect.objectContaining({ force: true, text: 'ls /' }));
    expect(editor.isShowingAutocomplete()).toBe(true);
  });

  it('keeps force:false (slash menu) for a leading / in prompt mode', async () => {
    const editor = makeEditor();
    const { provider, calls } = providerRecordingForce([{ value: 'help', label: 'help' }]);
    editor.setAutocompleteProvider(provider);
    // inputMode defaults to 'prompt'

    editor.handleInput('/');
    await flushAutocomplete();

    expect(calls).toContainEqual(expect.objectContaining({ force: false, text: '/' }));
    expect(editor.isShowingAutocomplete()).toBe(true);
  });

  it('never falls back to force:false for a slash-shaped command in bash mode', async () => {
    const editor = makeEditor();
    const { provider, calls } = providerRecordingForce([{ value: 'list', label: 'list' }]);
    editor.setAutocompleteProvider(provider);
    editor.inputMode = 'bash';

    for (const char of '/add-dir ') {
      editor.handleInput(char);
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    await flushAutocomplete();

    // A force:false request would let pi-tui's own slash-command handling pop
    // up subcommand completions for `/add-dir `. Bash mode must only ever
    // request force:true path completion.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.force === true)).toBe(true);
  });
});
