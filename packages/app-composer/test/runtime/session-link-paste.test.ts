// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createComposerEditor } from '../../src/runtime/createEditor';
import { runComposerMenuEdit } from '../../src/runtime/editorRegistry';
import type { ComposerEditorApi, ComposerEditorOptions } from '../../src/runtime/contracts';

const editors: ComposerEditorApi[] = [];

function mountEditor(options: Partial<ComposerEditorOptions> = {}): ComposerEditorApi {
  const host = document.createElement('div');
  document.body.append(host);
  const editor = createComposerEditor(host, {
    initialText: '',
    onChange: () => {},
    handleKeyDown: () => false,
    ...options,
  });
  editors.push(editor);
  return editor;
}

function paste(editor: ComposerEditorApi, text: string): void {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: (type: string) => (type === 'text/plain' ? text : ''), types: ['text/plain'], items: [], files: [] },
  });
  editor.dom.dispatchEvent(event);
}

function sessionPills(editor: ComposerEditorApi): Array<{ name: string | null; path: string | null }> {
  return [...editor.dom.querySelectorAll<HTMLElement>('.mention-session')].map((pill) => ({
    name: pill.querySelector('.mention-pill-name')?.textContent ?? null,
    path: pill.getAttribute('data-mention-path'),
  }));
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.replaceChildren();
});

describe('pasting a bare session address', () => {
  it('becomes a session pill titled with the known session title', () => {
    const editor = mountEditor({ sessionLinks: { title: (id) => (id === 'session_1' ? 'Fix login' : undefined) } });
    paste(editor, 'see kimi-code://sessions/session_1');
    expect(sessionPills(editor)).toEqual([{ name: 'Fix login', path: 'session_1' }]);
    expect(editor.getText()).toBe('see [Fix login](kimi-code://sessions/session_1)');
  });

  it('names an unknown session by its id until its title loads, without adding an undo step', async () => {
    let resolveTitle!: (title: string | undefined) => void;
    const loadTitle = vi.fn(() => new Promise<string | undefined>((resolve) => { resolveTitle = resolve; }));
    const editor = mountEditor({ sessionLinks: { title: () => undefined, loadTitle } });
    paste(editor, 'kimi-code://sessions/session_old');
    expect(loadTitle).toHaveBeenCalledExactlyOnceWith('session_old');
    expect(sessionPills(editor)).toEqual([{ name: 'session_old', path: 'session_old' }]);

    resolveTitle('Old work');
    await vi.waitFor(() => expect(sessionPills(editor)).toEqual([{ name: 'Old work', path: 'session_old' }]));
    expect(editor.getText()).toBe('[Old work](kimi-code://sessions/session_old)');

    expect(runComposerMenuEdit(editor.dom, 'undo')).toBe(true);
    expect(editor.getText()).toBe('');
  });

  it('keeps the id as the name when the title cannot be loaded', async () => {
    const loadTitle = vi.fn(async () => undefined);
    const editor = mountEditor({ sessionLinks: { title: () => undefined, loadTitle } });
    paste(editor, 'kimi-code://sessions/session_gone');
    await Promise.resolve();
    expect(sessionPills(editor)).toEqual([{ name: 'session_gone', path: 'session_gone' }]);
  });

  it('leaves existing session links as they are', () => {
    const title = vi.fn(() => 'Resolved');
    const editor = mountEditor({ sessionLinks: { title } });
    paste(editor, '[Alpha](kimi-code://sessions/session_1)');
    expect(sessionPills(editor)).toEqual([{ name: 'Alpha', path: 'session_1' }]);
    expect(title).not.toHaveBeenCalled();
  });

  it('stays plain text while the host has session links switched off', () => {
    const title = vi.fn(() => 'Fix login');
    const editor = mountEditor({ sessionLinks: { enabled: () => false, title } });
    paste(editor, 'kimi-code://sessions/session_1');
    expect(sessionPills(editor)).toEqual([]);
    expect(title).not.toHaveBeenCalled();
  });

  it('stays plain text when the host does not resolve session links', () => {
    const editor = mountEditor();
    paste(editor, 'kimi-code://sessions/session_1');
    expect(sessionPills(editor)).toEqual([]);
    expect(editor.getText()).toBe('kimi-code://sessions/session_1');
  });
});
