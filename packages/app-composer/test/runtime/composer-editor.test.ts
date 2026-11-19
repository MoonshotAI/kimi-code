import { describe, expect, it, vi } from 'vitest';
import { EditorState } from 'prosemirror-state';
import type { Decoration, DecorationSet } from 'prosemirror-view';
import { attachmentKeyFor, attachmentRegistryKey, createAttachmentRegistryPlugin, type AttachmentEntry } from '../../src/features/attachment/registry';
import { attachmentErrorDecorations, composerClipboardSerializer, composerPlugins, createLeadingSlashCommandDecorations, leadingSlashCommandDecorations } from '../../src/runtime/plugins';
import { liveComposerEditorFor, registerLiveComposerEditor } from '../../src/runtime/editorRegistry';
import type { ComposerEditorApi } from '../../src/runtime/contracts';
import { composerSchema, docToText, posToTextOffset, quoteNode, removeAttachmentLinks, textToDoc } from '../../src/model';
import { buildSlashItems, modeCommandFor, parseSlash } from '@moonshot-ai/app-core/lib';
import { attachmentInventory } from '../../src/features/attachment/inventory';

const WIRE = 'see [a.pdf](kimi-code-composer://attachments/aaaaaaaa) and [b.pdf](kimi-code-composer://attachments/bbbbbbbb)';

function entry(overrides?: Partial<AttachmentEntry>): AttachmentEntry {
  return {
    attId: 'aaaaaaaa',
    key: attachmentKeyFor({ kind: 'file', attId: 'aaaaaaaa' }),
    kind: 'file',
    name: 'a.pdf',
    refCount: 1,
    uploading: false,
    ...overrides,
  };
}

function stateWith(entries: AttachmentEntry[]): EditorState {
  return EditorState.create({
    schema: composerSchema,
    doc: textToDoc(WIRE, { reviveMentions: true }),
    plugins: [createAttachmentRegistryPlugin({ initialEntries: entries }), attachmentErrorDecorations],
  });
}

function erroredClasses(state: EditorState): { from: number; to: number; class?: string }[] {
  const decos = attachmentErrorDecorations.props.decorations?.call(null, state) as DecorationSet | null | undefined;
  if (!decos) return [];
  return decos.find().map((deco: Decoration) => ({ from: deco.from, to: deco.to, class: deco.type.attrs.class as string | undefined }));
}

function submitExecutesCommand(source: string, towerEnabled = false): boolean {
  const bare = removeAttachmentLinks(source.trim());
  if (modeCommandFor(bare.trim()) !== undefined) return true;
  const cmd = parseSlash(bare)?.cmd;
  if (cmd === undefined) return false;
  const item = buildSlashItems([], { towerEnabled }).find((entry) => entry.name === cmd);
  if (item === undefined) return false;
  if (item.noArgs !== true) return true;
  return (parseSlash(bare.trim())?.arg ?? '').trim() === '';
}

function fileLink(attId: string, name = 'a.pdf'): string {
  return `[${name}](kimi-code-composer://attachments/${attId})`;
}

function commandState(text: string, reviveMentions = false, towerEnabled?: boolean): EditorState {
  return EditorState.create({
    schema: composerSchema,
    doc: textToDoc(text, { reviveMentions }),
    plugins: [
      towerEnabled === undefined
        ? leadingSlashCommandDecorations
        : createLeadingSlashCommandDecorations(() => buildSlashItems([], { towerEnabled })),
    ],
  });
}

function commandDecorationsIn(state: EditorState): Decoration[] {
  const plugin = state.plugins[0]!;
  const decos = plugin.props.decorations?.call(null, state) as DecorationSet | null | undefined;
  return decos?.find() ?? [];
}

function commandDecorations(text: string): Decoration[] {
  return commandDecorationsIn(commandState(text));
}

function highlightedSource(text: string, reviveMentions = false): string | null {
  const state = commandState(text, reviveMentions);
  const deco = commandDecorationsIn(state)[0];
  if (!deco) return null;
  const source = docToText(state.doc);
  return source.slice(posToTextOffset(state.doc, deco.from), posToTextOffset(state.doc, deco.to));
}

describe('leading slash command decorations', () => {
  it('highlights a known command without changing the document', () => {
    const decos = commandDecorations('/compact ');
    expect(decos).toHaveLength(1);
    expect(decos[0]).toMatchObject({ from: 1, to: 9 });
    expect(decos[0]?.type.attrs).toMatchObject({
      class: 'composer-command-token',
      'data-command-name': '/compact',
    });
  });

  it('keeps the highlight when an argument exists', () => {
    const decos = commandDecorations('/compact keep details');
    expect(decos).toHaveLength(1);
    expect(decos[0]?.type.attrs.class).toBe('composer-command-token');
  });

  it('highlights after leading spaces and rejects commands after text', () => {
    expect(commandDecorations('  /compact')[0]).toMatchObject({ from: 3, to: 11 });
    expect(commandDecorations('explain /compact')).toEqual([]);
  });

  it('does not decorate unknown or invalid no-argument commands', () => {
    expect(commandDecorations('/compactx')).toEqual([]);
    expect(commandDecorations('/new session')).toEqual([]);
  });

  it('highlights a command the submit path reaches past a leading newline', () => {
    expect(highlightedSource('\n/clear')).toBe('/clear');
    expect(highlightedSource('\n\n  /compact')).toBe('/compact');
  });

  it('leaves a command that ordinary text precedes on an earlier line undecorated', () => {
    expect(commandDecorations('explain this\n/clear')).toEqual([]);
  });

  it('highlights a no-argument command whose only trailing token is an attachment pill', () => {
    expect(highlightedSource(`/clear ${fileLink('aaaaaaaa')}`, true)).toBe('/clear');
    expect(highlightedSource(`/new ${fileLink('aaaaaaaa')}`, true)).toBe('/new');
  });

  it('drops the decoration plugin when the host does not run commands', () => {
    const docFor = (recognize: boolean): EditorState => EditorState.create({
      schema: composerSchema,
      doc: textToDoc('/compact tighten it'),
      plugins: composerPlugins(undefined, undefined, undefined, undefined, recognize),
    });
    const decorationsOf = (state: EditorState): number =>
      state.plugins.reduce((count, plugin) => {
        const decos = plugin.props?.decorations?.call(plugin, state) as DecorationSet | null | undefined;
        return count + (decos?.find().filter((deco) => deco.type.attrs?.class === 'composer-command-token').length ?? 0);
      }, 0);
    expect(decorationsOf(docFor(true))).toBe(1);
    expect(decorationsOf(docFor(false))).toBe(0);
  });

  it('highlights a bare mode command that an attachment pill precedes', () => {
    for (const cmd of ['/plan', '/goal', '/swarm']) {
      expect(highlightedSource(`${fileLink('aaaaaaaa')} ${cmd}`, true)).toBe(cmd);
    }
  });

  it('does not extend the mode-branch reading to an argument or a non-mode command', () => {
    expect(commandDecorationsIn(commandState(`${fileLink('aaaaaaaa')} /swarm on`, true))).toEqual([]);
    expect(commandDecorationsIn(commandState(`${fileLink('aaaaaaaa')} /compact`, true))).toEqual([]);
  });

  it('leaves a command an attachment pill precedes undecorated, as the submit path does', () => {
    expect(commandDecorationsIn(commandState(`${fileLink('aaaaaaaa')} /new`, true))).toEqual([]);
    expect(highlightedSource(`${fileLink('aaaaaaaa')}/new`, true)).toBe('/new');
  });

  it('decorates exactly the inputs the submit path executes as a built-in command', () => {
    const inputs = [
      '/clear',
      '\n/clear',
      '  /compact',
      '/compact tighten it',
      '/new session',
      'explain /clear',
      `/clear ${fileLink('aaaaaaaa')}`,
      `/new ${fileLink('aaaaaaaa')}`,
      `${fileLink('aaaaaaaa')} /new`,
      `${fileLink('aaaaaaaa')}/new`,
      `/new ${fileLink('aaaaaaaa')} session`,
      '/tower',
      '/compact',
      '/plan',
      '/goal',
      '/swarm',
      `${fileLink('aaaaaaaa')} /plan`,
      `${fileLink('aaaaaaaa')} /goal`,
      `${fileLink('aaaaaaaa')} /swarm`,
      `${fileLink('aaaaaaaa')} /swarm on`,
      `${fileLink('aaaaaaaa')} /compact`,
      `/plan ${fileLink('aaaaaaaa')}`,
      '/goal fix the flake',
    ];
    for (const input of inputs) {
      const source = docToText(commandState(input, true).doc);
      expect({ input, decorated: commandDecorationsIn(commandState(input, true)).length > 0 })
        .toEqual({ input, decorated: submitExecutesCommand(source) });
    }
  });

  it('follows the tower flag the way the submit path does', () => {
    for (const towerEnabled of [false, true]) {
      for (const input of ['/tower', '/tower main', `${fileLink('aaaaaaaa')}/tower`, 'explain /tower']) {
        const state = commandState(input, true, towerEnabled);
        expect({ input, towerEnabled, decorated: commandDecorationsIn(state).length > 0 })
          .toEqual({ input, towerEnabled, decorated: submitExecutesCommand(docToText(state.doc), towerEnabled) });
      }
    }
  });

  it('still rejects a no-argument command carrying real argument text beside a pill', () => {
    expect(commandDecorationsIn(commandState(`/new ${fileLink('aaaaaaaa')} session`, true))).toEqual([]);
  });
});

describe('attachmentErrorDecorations', () => {
  it('marks exactly the pills whose registry entry carries an error', () => {
    const state = stateWith([
      entry({ error: 'upload-failed' }),
      entry({ attId: 'bbbbbbbb', key: attachmentKeyFor({ kind: 'file', attId: 'bbbbbbbb' }), name: 'b.pdf' }),
    ]);
    const decos = erroredClasses(state);
    expect(decos).toHaveLength(1);
    expect(decos[0]!.class).toBe('attachment-error');
    const node = state.doc.nodeAt(decos[0]!.from)!;
    expect(node.type).toBe(composerSchema.nodes.attachment);
    expect(node.attrs.attId).toBe('aaaaaaaa');
    expect(decos[0]!.to).toBe(decos[0]!.from + node.nodeSize);
  });

  it('returns no decorations when every pill has a healthy entry', () => {
    expect(erroredClasses(stateWith([entry(), entry({ attId: 'bbbbbbbb', key: attachmentKeyFor({ kind: 'file', attId: 'bbbbbbbb' }), name: 'b.pdf' })]))).toEqual([]);
  });

  it('marks an entry-less pill missing immediately (an undo-resurrected pill whose entry the reconcile dropped)', () => {
    const decos = erroredClasses(stateWith([]));
    expect(decos).toHaveLength(2);
    expect(decos.every((deco) => deco.class === 'attachment-missing')).toBe(true);
    const partialState = stateWith([entry()]);
    const partial = erroredClasses(partialState);
    expect(partial).toHaveLength(1);
    expect(partial[0]!.class).toBe('attachment-missing');
    expect(partialState.doc.nodeAt(partial[0]!.from)!.attrs.attId).toBe('bbbbbbbb');
  });

  it('marks every pill referencing the errored entry (refCount > 1) and unmarks on recovery', () => {
    const twice = 'see [a.pdf](kimi-code-composer://attachments/aaaaaaaa) twice [a.pdf](kimi-code-composer://attachments/aaaaaaaa)';
    const errored = EditorState.create({
      schema: composerSchema,
      doc: textToDoc(twice, { reviveMentions: true }),
      plugins: [createAttachmentRegistryPlugin({ initialEntries: [entry({ error: 'upload-interrupted' })] }), attachmentErrorDecorations],
    });
    expect(erroredClasses(errored)).toHaveLength(2);
    const recovered = errored.apply(
      errored.tr.setMeta(attachmentRegistryKey, { type: 'patch', attId: 'aaaaaaaa', patch: { uploading: true, error: undefined } }),
    );
    expect(erroredClasses(recovered)).toEqual([]);
  });
});

describe('composerPlugins inventory rebuild', () => {
  it('re-inits active attachment identity from the passed entries', () => {
    const sessionA = entry({ attId: '1', key: 'blob:1', fileId: 'f_a' });
    const mounted = EditorState.create({
      schema: composerSchema,
      doc: textToDoc('[a.pdf](kimi-code-composer://attachments/1)', { reviveMentions: true }),
      plugins: composerPlugins([sessionA]),
    });
    expect(attachmentInventory(mounted).orderedIds).toEqual(['1']);
    expect(attachmentInventory(mounted).refCounts.get('1')).toBe(1);

    const sessionB = entry({ attId: '1', key: 'blob:1', name: 'b.pdf', fileId: 'f_b' });
    const switched = EditorState.create({
      schema: composerSchema,
      doc: textToDoc('[b.pdf](kimi-code-composer://attachments/1)', { reviveMentions: true }),
      plugins: composerPlugins([sessionB]),
    });
    expect(attachmentInventory(switched).orderedIds).toEqual(['1']);
  });

  it('re-inits to EMPTY by default — a rebuild inherits nothing', () => {
    const cleared = EditorState.create({
      schema: composerSchema,
      doc: textToDoc('[a.pdf](kimi-code-composer://attachments/1)', { reviveMentions: true }),
      plugins: composerPlugins(),
    });
    expect(attachmentInventory(cleared).orderedIds).toEqual([]);
  });

  it('preserves active entries the new doc does not reference', () => {
    const state = EditorState.create({
      schema: composerSchema,
      doc: textToDoc('plain text', { reviveMentions: true }),
      plugins: composerPlugins([entry({ attId: '1', key: 'blob:1', fileId: 'f_a' })]),
    });
    expect(attachmentInventory(state).orderedIds).toEqual(['1']);
    expect(attachmentInventory(state).refCounts.has('1')).toBe(false);
  });

  it('a same-session rebuild carrying the current entries preserves inventory', () => {
    const current = entry({ attId: '1', key: 'blob:1', fileId: 'f_a' });
    const rebuilt = EditorState.create({
      schema: composerSchema,
      doc: textToDoc('edited @tok [a.pdf](kimi-code-composer://attachments/1)', { reviveMentions: true }),
      plugins: composerPlugins([current]),
    });
    expect(attachmentInventory(rebuilt).orderedIds).toEqual(['1']);
    expect(attachmentInventory(rebuilt).refCounts.get('1')).toBe(1);
    const cleared = EditorState.create({
      schema: composerSchema,
      doc: textToDoc('', { reviveMentions: true }),
      plugins: composerPlugins([current]),
    });
    expect(attachmentInventory(cleared).orderedIds).toEqual(['1']);
    expect(attachmentInventory(cleared).refCounts.has('1')).toBe(false);
  });

  it('keeps active identity independent of the currently rendered references', () => {
    const draft = 'see [a.pdf](kimi-code-composer://attachments/aaaaaaaa)';
    const uploaded = entry({ attId: 'aaaaaaaa', key: 'blob:aaaaaaaa', fileId: 'f_ready' });
    EditorState.create({
      schema: composerSchema,
      doc: textToDoc(draft, { reviveMentions: true }),
      plugins: composerPlugins([uploaded]),
    });
    const browsing = EditorState.create({
      schema: composerSchema,
      doc: textToDoc('an old message', { reviveMentions: true }),
      plugins: composerPlugins([uploaded]),
    });
    expect(attachmentInventory(browsing).orderedIds).toEqual(['aaaaaaaa']);
    expect(attachmentInventory(browsing).refCounts.has('aaaaaaaa')).toBe(false);

    const returned = EditorState.create({
      schema: composerSchema,
      doc: textToDoc(draft, { reviveMentions: true }),
      plugins: composerPlugins([uploaded]),
    });
    expect(attachmentInventory(returned).orderedIds).toEqual(['aaaaaaaa']);
    expect(attachmentInventory(returned).refCounts.get('aaaaaaaa')).toBe(1);
  });
});

describe('live editor registry', () => {
  it('latest registration wins; a non-owner release keeps the newer registration', () => {
    const first = { updateAttachmentEntry: vi.fn() } as unknown as ComposerEditorApi;
    const second = { updateAttachmentEntry: vi.fn() } as unknown as ComposerEditorApi;
    const releaseFirst = registerLiveComposerEditor('sess_1', first);
    const releaseSecond = registerLiveComposerEditor('sess_1', second);
    releaseFirst();
    expect(liveComposerEditorFor('sess_1')).toBe(second);
    releaseSecond();
    expect(liveComposerEditorFor('sess_1')).toBeUndefined();
  });
});

describe('composerClipboardSerializer — quote pill HTML flavor', () => {
  it('serializes the FULL quote text, not the truncated pill label', () => {
    const long = '这是一段远超二十四字素截断上限的完整引用文本\n第二行也要完整保留';
    const spec = composerClipboardSerializer.nodes.quote!;
    const dom = spec(quoteNode({ text: long }), null as never);
    const serialized = JSON.stringify(dom);
    expect(serialized).toContain('这是一段远超二十四字素截断上限的完整引用文本');
    expect(serialized).toContain('第二行也要完整保留');
    expect(serialized).not.toContain('…');
  });

  it('keeps line boundaries in the HTML flavor (pre-wrap — default white-space would collapse newlines)', () => {
    const spec = composerClipboardSerializer.nodes.quote!;
    const dom = spec(quoteNode({ text: '第一行\n第二行' }), null as never);
    expect(JSON.stringify(dom)).toContain('white-space: pre-wrap');
  });
});
