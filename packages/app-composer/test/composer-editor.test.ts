// packages/app-composer/test/composer-editor.test.ts
// The composer editor's registry-driven pill ERROR decorations: an entry
// carrying an upload error marks its pills .attachment-error via a node
// decoration (merged onto the NodeView dom); clearing the error unmarks
// them. Driven as a pure function of the EditorState — no EditorView, so
// the default node environment suffices.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from 'prosemirror-state';
import type { Decoration, DecorationSet } from 'prosemirror-view';
import { attachmentKeyFor, attachmentRegistryKey, createAttachmentRegistryPlugin, type AttachmentEntry } from '../src/attachmentRegistry';
import { attachmentErrorDecorations, composerClipboardSerializer, composerPlugins, deliverPillEntryPatch, liveComposerEditorFor, registerLiveComposerEditor, type ComposerEditorApi } from '../src/composerEditor';
import { clearStashedEditorStates, stashEditorState, takeEditorState } from '../src/editorStateCache';
import { composerSchema, quoteNode, textToDoc } from '../src/composerTextDoc';

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

describe('attachmentErrorDecorations', () => {
  it('marks exactly the pills whose registry entry carries an error', () => {
    const state = stateWith([
      entry({ error: 'upload-failed' }),
      entry({ attId: 'bbbbbbbb', key: attachmentKeyFor({ kind: 'file', attId: 'bbbbbbbb' }), name: 'b.pdf' }),
    ]);
    const decos = erroredClasses(state);
    expect(decos).toHaveLength(1);
    expect(decos[0]!.class).toBe('attachment-error');
    // The decoration covers exactly the errored pill's node range.
    const node = state.doc.nodeAt(decos[0]!.from)!;
    expect(node.type).toBe(composerSchema.nodes.attachment);
    expect(node.attrs.attId).toBe('aaaaaaaa');
    expect(decos[0]!.to).toBe(decos[0]!.from + node.nodeSize);
  });

  it('returns no decorations when every pill has a healthy entry', () => {
    expect(erroredClasses(stateWith([entry(), entry({ attId: 'bbbbbbbb', key: attachmentKeyFor({ kind: 'file', attId: 'bbbbbbbb' }), name: 'b.pdf' })]))).toEqual([]);
  });

  it('marks an entry-less pill missing immediately (an undo-resurrected pill whose entry the reconcile dropped)', () => {
    // No registry entries at all: both revived pills are dead — the send
    // gate would close with no visible reason without the immediate marking
    // (the tooltip resolver only adds the class on hover).
    const decos = erroredClasses(stateWith([]));
    expect(decos).toHaveLength(2);
    expect(decos.every((deco) => deco.class === 'attachment-missing')).toBe(true);
    // A partial registry marks only the entry-less pill.
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
    // The re-drop retry patches the error away — the same pass unmarks.
    const recovered = errored.apply(
      errored.tr.setMeta(attachmentRegistryKey, { type: 'patch', attId: 'aaaaaaaa', patch: { uploading: true, error: undefined } }),
    );
    expect(erroredClasses(recovered)).toEqual([]);
  });
});

describe('composerPlugins registry rebuild (the setText semantics)', () => {
  // A wholesale setText re-seeds the registry from the entries the CALLER
  // passes — NEVER from the editor-creation (mount session's) entries. Edit
  // refills use stable 1..N attIds, so cross-session attId collisions are
  // common: an inherited rebuild would let the old session's fileId into
  // the new session's registry (and sidecar, via the change notify).
  it('re-inits from the passed entries, not the mount session’s', () => {
    const sessionA = entry({ attId: '1', key: 'blob:1', fileId: 'f_a' });
    const mounted = EditorState.create({
      schema: composerSchema,
      doc: textToDoc('[a.pdf](kimi-code-composer://attachments/1)', { reviveMentions: true }),
      plugins: composerPlugins([sessionA]),
    });
    expect(attachmentRegistryKey.getState(mounted)!.get('1')!.fileId).toBe('f_a');

    // Session switch without a stash: the new draft references the SAME
    // attId '1' (a 1..N collision), and its sidecar maps it to f_b.
    const sessionB = entry({ attId: '1', key: 'blob:1', name: 'b.pdf', fileId: 'f_b' });
    const switched = EditorState.create({
      schema: composerSchema,
      doc: textToDoc('[b.pdf](kimi-code-composer://attachments/1)', { reviveMentions: true }),
      plugins: composerPlugins([sessionB]),
    });
    expect(attachmentRegistryKey.getState(switched)!.get('1')!.fileId).toBe('f_b');
  });

  it('re-inits to EMPTY by default — a rebuild inherits nothing', () => {
    // The same rebuild shape setText uses for callers without entries
    // (submit clear, history recall): the revived pill is dead until an
    // explicit re-seed, and no mount-session entry can leak through.
    const cleared = EditorState.create({
      schema: composerSchema,
      doc: textToDoc('[a.pdf](kimi-code-composer://attachments/1)', { reviveMentions: true }),
      plugins: composerPlugins(),
    });
    expect(attachmentRegistryKey.getState(cleared)!.size).toBe(0);
  });

  it('drops entries the new doc does not reference (the init reconcile)', () => {
    const state = EditorState.create({
      schema: composerSchema,
      doc: textToDoc('plain text', { reviveMentions: true }),
      plugins: composerPlugins([entry({ attId: '1', key: 'blob:1', fileId: 'f_a' })]),
    });
    expect(attachmentRegistryKey.getState(state)!.size).toBe(0);
  });

  it('a same-session rebuild carrying the CURRENT entries preserves the registry (the text-watcher path)', () => {
    // The composer's text watcher passes the CURRENT entries for
    // same-session rebuilds (the mobile mention sheet's token rewriting):
    // the registry — and with it the sidecar the change-notify persists —
    // survives the rebuild instead of being wiped to empty (the bare
    // setText default).
    const current = entry({ attId: '1', key: 'blob:1', fileId: 'f_a' });
    const rebuilt = EditorState.create({
      schema: composerSchema,
      doc: textToDoc('edited @tok [a.pdf](kimi-code-composer://attachments/1)', { reviveMentions: true }),
      plugins: composerPlugins([current]),
    });
    expect(attachmentRegistryKey.getState(rebuilt)!.get('1')!.fileId).toBe('f_a');
    // …and the init reconcile still drops entries the new text dropped
    // (a submit clear empties the registry exactly as before).
    const cleared = EditorState.create({
      schema: composerSchema,
      doc: textToDoc('', { reviveMentions: true }),
      plugins: composerPlugins([current]),
    });
    expect(attachmentRegistryKey.getState(cleared)!.size).toBe(0);
  });

  it('the history-walk round trip: browsing drops the registry, the snapshot restore re-seeds it', () => {
    // Mirrors the composer's ↑/↓ flow: a draft with an uploaded pill steps
    // back to a link-less history entry (same-session rebuild) — the init
    // reconcile empties the registry — then the walk home restores the
    // draft text and re-upserts the browse-start snapshot: the pill's
    // fileId is back.
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
    expect(attachmentRegistryKey.getState(browsing)!.size).toBe(0);

    const returned = EditorState.create({
      schema: composerSchema,
      doc: textToDoc(draft, { reviveMentions: true }),
      plugins: composerPlugins([]),
    });
    const restored = returned.apply(
      returned.tr.setMeta(attachmentRegistryKey, { type: 'upsert', entry: uploaded }),
    );
    // The pill's fileId is back (refCount re-derives on the next doc change
    // — a meta-only upsert does not re-count, same as the edit refill's
    // seeding path).
    expect(attachmentRegistryKey.getState(restored)!.get('aaaaaaaa')).toMatchObject({
      fileId: 'f_ready',
      uploading: false,
    });
  });
});

describe('live editor registry + deliverPillEntryPatch (async upload-outcome delivery)', () => {
  afterEach(() => {
    clearStashedEditorStates();
  });

  it('routes the outcome to the LIVE editor registered for the session (the remount timing)', () => {
    // The callback's own composer instance is gone (unmounted by a
    // question/approval) and the remount consumed the stash — the outcome
    // must reach the editor that NOW holds the session, or the entry stays
    // `uploading` forever with its fileId lost.
    const updateAttachmentEntry = vi.fn();
    const release = registerLiveComposerEditor('sess_1', { updateAttachmentEntry } as unknown as ComposerEditorApi);
    deliverPillEntryPatch('sess_1', 'aaaaaaaa', { fileId: 'f_late', uploading: false, error: undefined }, {
      loadEntries: () => [],
      saveEntries: () => {},
    });
    expect(updateAttachmentEntry).toHaveBeenCalledWith('aaaaaaaa', { fileId: 'f_late', uploading: false, error: undefined });
    release();
    expect(liveComposerEditorFor('sess_1')).toBeUndefined();
  });

  it('latest registration wins; a non-owner release keeps the newer registration', () => {
    const first = { updateAttachmentEntry: vi.fn() } as unknown as ComposerEditorApi;
    const second = { updateAttachmentEntry: vi.fn() } as unknown as ComposerEditorApi;
    const releaseFirst = registerLiveComposerEditor('sess_1', first);
    const releaseSecond = registerLiveComposerEditor('sess_1', second);
    releaseFirst(); // a stale release must not yank the newer registration
    expect(liveComposerEditorFor('sess_1')).toBe(second);
    releaseSecond();
    expect(liveComposerEditorFor('sess_1')).toBeUndefined();
  });

  it('patches the stashed state and mirrors it to the sidecar when nothing is live (completed while unmounted)', () => {
    const uploading = entry({ attId: 'aaaaaaaa', uploading: true, fileId: undefined });
    stashEditorState('sess_1', stateWith([uploading]));
    const saved: AttachmentEntry[][] = [];
    deliverPillEntryPatch('sess_1', 'aaaaaaaa', { fileId: 'f_late', uploading: false, error: undefined }, {
      loadEntries: () => {
        throw new Error('the stash branch must not hit the sidecar fallback');
      },
      saveEntries: (entries) => saved.push([...entries]),
    });
    // The stash carries the outcome (the next restore adopts it)…
    const restashed = takeEditorState('sess_1')!;
    expect(attachmentRegistryKey.getState(restashed)!.get('aaaaaaaa')).toMatchObject({
      uploading: false,
      fileId: 'f_late',
      error: undefined,
    });
    // …and the sidecar mirrors it NOW (a reload never resurrects `uploading`).
    expect(saved).toHaveLength(1);
    expect(saved[0]![0]).toMatchObject({ attId: 'aaaaaaaa', fileId: 'f_late' });
  });

  it('falls back to the sidecar when nothing is live or stashed (the next sidecar load heals)', () => {
    const stored = [entry({ attId: 'aaaaaaaa', uploading: true, fileId: undefined })];
    const saved: AttachmentEntry[][] = [];
    deliverPillEntryPatch('sess_1', 'aaaaaaaa', { fileId: 'f_late', uploading: false, error: undefined }, {
      loadEntries: () => stored,
      saveEntries: (entries) => saved.push([...entries]),
    });
    expect(stored[0]).toMatchObject({ uploading: false, fileId: 'f_late', error: undefined });
    expect(saved).toHaveLength(1);
  });

  it('is a no-op for an attId the sidecar does not know (never fabricates an entry)', () => {
    const saveEntries = vi.fn();
    deliverPillEntryPatch('sess_1', 'unknown0', { fileId: 'f_late', uploading: false }, {
      loadEntries: () => [],
      saveEntries,
    });
    expect(saveEntries).not.toHaveBeenCalled();
  });

  it("routes the empty session's outcome to its live editor too (the landing-page scope)", () => {
    // The landing-page composer registers under the shared '__new__' scope
    // (app-core's NEW_SESSION_SCOPE — the storage key functions pin against
    // it in the app tests): an upload outcome must reach the mounted editor
    // LIVE — a sidecar-only path left the entry stuck on `uploading` and
    // the first message blocked by the send gate.
    const updateAttachmentEntry = vi.fn();
    const release = registerLiveComposerEditor('__new__', { updateAttachmentEntry } as unknown as ComposerEditorApi);
    deliverPillEntryPatch('__new__', 'aaaaaaaa', { fileId: 'f_first', uploading: false, error: undefined }, {
      loadEntries: () => [],
      saveEntries: () => {},
    });
    expect(updateAttachmentEntry).toHaveBeenCalledWith('aaaaaaaa', { fileId: 'f_first', uploading: false, error: undefined });
    release();
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
    // Sanity: the pill label would have been truncated — the HTML flavor
    // must NOT cap at it.
    expect(serialized).not.toContain('…');
  });

  it('keeps line boundaries in the HTML flavor (pre-wrap — default white-space would collapse newlines)', () => {
    const spec = composerClipboardSerializer.nodes.quote!;
    const dom = spec(quoteNode({ text: '第一行\n第二行' }), null as never);
    expect(JSON.stringify(dom)).toContain('white-space: pre-wrap');
  });
});
