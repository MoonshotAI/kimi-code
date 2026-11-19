// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createComposerEditor } from '../../src/runtime/createEditor';
import type { ComposerEditorApi, ComposerEditorOptions } from '../../src/runtime/contracts';
import { PASTED_TEXT_MIN_CHARS, serializePastedText } from '../../src/model';

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

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.replaceChildren();
});

describe('pasting long text', () => {
  it('folds a long paste into a pasted-text pill', () => {
    const editor = mountEditor({ pastedTextMeta: (n) => `${n} lines` });
    const body = `head\r\n${'x'.repeat(PASTED_TEXT_MIN_CHARS)}`;
    paste(editor, body);
    const normalized = body.replace(/\r\n/g, '\n');
    expect(editor.getText()).toBe(serializePastedText({ text: normalized }));
    const pill = editor.dom.querySelector<HTMLElement>('.pasted-text-pill');
    expect(pill?.dataset.pastedText).toBe(normalized);
    expect(pill?.querySelector('.quote-pill-name')?.textContent).toBe('head');
    expect(pill?.querySelector('.quote-pill-comment')?.textContent).toBe('2 lines');
  });

  it('keeps a short paste as text', () => {
    const editor = mountEditor();
    paste(editor, 'short body');
    expect(editor.getText()).toBe('short body');
    expect(editor.dom.querySelector('.pasted-text-pill')).toBeNull();
  });
});

describe('editing a pasted-text pill', () => {
  it('rewrites the pill text in place', async () => {
    const { updateComposerPastedText } = await import('../../src/runtime/editorRegistry');
    const editor = mountEditor();
    paste(editor, `alpha\n${'y'.repeat(PASTED_TEXT_MIN_CHARS)}`);
    const pill = editor.dom.querySelector<HTMLElement>('.pasted-text-pill');
    expect(updateComposerPastedText(pill!, 'edited\r\nbody')).toBe(true);
    expect(editor.getText()).toBe(serializePastedText({ text: 'edited\nbody' }));
    expect(editor.dom.querySelector<HTMLElement>('.pasted-text-pill')?.dataset.pastedText).toBe('edited\nbody');
  });
});
