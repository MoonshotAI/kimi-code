// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { buildSlashItems } from '@moonshot-ai/app-core/lib';
import { createComposerEditor } from '../../src/runtime/createEditor';
import type { ComposerEditorApi, ComposerEditorOptions } from '../../src/runtime/contracts';

const editors: ComposerEditorApi[] = [];

function mountEditor(options: Partial<ComposerEditorOptions> = {}): { editor: ComposerEditorApi; host: HTMLElement } {
  const host = document.createElement('div');
  document.body.append(host);
  const editor = createComposerEditor(host, {
    initialText: '',
    onChange: () => {},
    handleKeyDown: () => false,
    ...options,
  });
  editors.push(editor);
  return { editor, host };
}

function highlighted(host: HTMLElement): string[] {
  return [...host.querySelectorAll('.composer-command-token')].map((node) => node.textContent ?? '');
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.replaceChildren();
});

describe('slash command recognition in the live editor', () => {
  it('highlights a command typed into a recognizing editor', () => {
    const { editor, host } = mountEditor();
    editor.setText('/compact');
    expect(highlighted(host)).toEqual(['/compact']);
  });

  it('keeps recognition off after setText rebuilds the state', () => {
    const { editor, host } = mountEditor({ recognizeSlashCommands: false });
    editor.setText('/compact');
    expect(highlighted(host)).toEqual([]);
  });

  it('keeps recognition off after setSnapshot rebuilds the state', () => {
    const source = mountEditor();
    source.editor.setText('/btw why');
    const snapshot = source.editor.getSnapshot();
    const { editor, host } = mountEditor({ recognizeSlashCommands: false });
    editor.setSnapshot(snapshot);
    expect(highlighted(host)).toEqual([]);
  });

  it('highlights /tower when the host enables it', () => {
    const { editor, host } = mountEditor({ slashCommands: buildSlashItems([], { towerEnabled: true }) });
    editor.setText('/tower main');
    expect(highlighted(host)).toEqual(['/tower']);
  });

  it('leaves /tower plain without the flag', () => {
    const { editor, host } = mountEditor();
    editor.setText('/tower main');
    expect(highlighted(host)).toEqual([]);
  });

  it('redraws the highlight when the host changes the command list', () => {
    const { editor, host } = mountEditor({ slashCommands: buildSlashItems() });
    editor.setText('/tower');
    expect(highlighted(host)).toEqual([]);
    editor.setSlashCommands(buildSlashItems([], { towerEnabled: true }));
    expect(highlighted(host)).toEqual(['/tower']);
    editor.setSlashCommands(buildSlashItems());
    expect(highlighted(host)).toEqual([]);
  });

  it('keeps /tower highlighted after setText rebuilds the state', () => {
    const { editor, host } = mountEditor({ slashCommands: buildSlashItems([], { towerEnabled: true }) });
    editor.setText('/clear');
    editor.setText('/tower');
    expect(highlighted(host)).toEqual(['/tower']);
  });

  it('does not let a command list turn recognition back on', () => {
    const { editor, host } = mountEditor({ recognizeSlashCommands: false });
    editor.setSlashCommands(buildSlashItems([], { towerEnabled: true }));
    editor.setText('/tower');
    expect(highlighted(host)).toEqual([]);
  });
});
