import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { history, redo, undo, undoDepth } from 'prosemirror-history';
import { buildAttachmentInsertion, composerSchema, docToText, textToDoc } from '../../../src/model';
import {
  activateAttachmentStep,
  applyAttachmentInventoryOperation,
  attachmentRefCounts,
  attachmentInventory,
  attachmentInventoryKey,
  createAttachmentInventoryPlugin,
  deactivateAttachmentTransaction,
  deactivateAttachmentStep,
  insertAttachmentsTransaction,
  removeAttachmentReferencesTransaction,
  reorderAttachmentStep,
} from '../../../src/features/attachment/inventory';

function createState(initialIds: readonly string[] = []): EditorState {
  return EditorState.create({
    schema: composerSchema,
    doc: textToDoc(''),
    plugins: [history(), createAttachmentInventoryPlugin(initialIds)],
  });
}

function applyUndo(state: EditorState): EditorState {
  let next = state;
  expect(undo(state, (tr) => {
    next = state.apply(tr);
  })).toBe(true);
  return next;
}

function applyRedo(state: EditorState): EditorState {
  let next = state;
  expect(redo(state, (tr) => {
    next = state.apply(tr);
  })).toBe(true);
  return next;
}

describe('attachment inventory reducer', () => {
  it('returns the same snapshot for no-ops and structurally shares untouched fields', () => {
    const initial = attachmentInventory(createState(['a']));
    const unchanged = applyAttachmentInventoryOperation(initial, { type: 'activate', attId: 'a', index: 0 });
    expect(unchanged).toBe(initial);

    const changed = applyAttachmentInventoryOperation(initial, { type: 'activate', attId: 'b', index: 1 });
    expect(changed).not.toBe(initial);
    expect(changed.refCounts).toBe(initial.refCounts);
    expect(changed.activeIds).not.toBe(initial.activeIds);
    expect(changed.orderedIds).not.toBe(initial.orderedIds);
    expect([...changed.orderedIds]).toEqual(['a', 'b']);
  });

  it('never mutates the previous Set or array', () => {
    const initial = attachmentInventory(createState(['a', 'b']));
    const changed = applyAttachmentInventoryOperation(initial, { type: 'deactivate', attId: 'a', index: 0 });
    expect([...initial.activeIds]).toEqual(['a', 'b']);
    expect([...initial.orderedIds]).toEqual(['a', 'b']);
    expect([...changed.activeIds]).toEqual(['b']);
    expect([...changed.orderedIds]).toEqual(['b']);
    expect(() => (initial.activeIds as Set<string>).add('c')).toThrow();
  });
});

describe('attachment inventory history', () => {
  it('records an inventory-only attachment activation in ProseMirror history', () => {
    let state = createState();
    state = state.apply(state.tr.step(activateAttachmentStep(state, 'a')));
    expect(attachmentInventory(state).orderedIds).toEqual(['a']);
    expect(undoDepth(state)).toBe(1);

    state = applyUndo(state);
    expect(attachmentInventory(state).orderedIds).toEqual([]);
    state = applyRedo(state);
    expect(attachmentInventory(state).orderedIds).toEqual(['a']);
  });

  it('undoes an activation and its inline reference as one gesture', () => {
    let state = createState();
    const attrs = { attId: 'a', name: 'shot.png', kind: 'image' as const };
    state = state.apply(
      buildAttachmentInsertion(state, attrs).step(activateAttachmentStep(state, 'a')),
    );
    expect(attachmentRefCounts(state.doc).get('a')).toBe(1);
    expect(attachmentInventory(state).orderedIds).toEqual(['a']);
    expect(undoDepth(state)).toBe(1);

    state = applyUndo(state);
    expect(attachmentRefCounts(state.doc).has('a')).toBe(false);
    expect(attachmentInventory(state).orderedIds).toEqual([]);
    state = applyRedo(state);
    expect(attachmentRefCounts(state.doc).get('a')).toBe(1);
    expect(attachmentInventory(state).orderedIds).toEqual(['a']);
  });

  it('restores a deactivated attachment at its original index', () => {
    let state = createState(['a', 'b', 'c']);
    const step = deactivateAttachmentStep(state, 'b');
    expect(step).not.toBeNull();
    state = state.apply(state.tr.step(step!));
    expect(attachmentInventory(state).orderedIds).toEqual(['a', 'c']);

    state = applyUndo(state);
    expect(attachmentInventory(state).orderedIds).toEqual(['a', 'b', 'c']);
    state = applyRedo(state);
    expect(attachmentInventory(state).orderedIds).toEqual(['a', 'c']);
  });

  it('reorders attachments as one reversible history event', () => {
    let state = createState(['a', 'b', 'c']);
    const step = reorderAttachmentStep(state, 'c', 0);
    expect(step).not.toBeNull();
    state = state.apply(state.tr.step(step!));
    expect(attachmentInventory(state).orderedIds).toEqual(['c', 'a', 'b']);
    expect(undoDepth(state)).toBe(1);

    state = applyUndo(state);
    expect(attachmentInventory(state).orderedIds).toEqual(['a', 'b', 'c']);
    state = applyRedo(state);
    expect(attachmentInventory(state).orderedIds).toEqual(['c', 'a', 'b']);
  });

  it('groups a batch in one transaction and one history event', () => {
    let state = createState();
    const tr = state.tr
      .step(activateAttachmentStep(state, 'a', 0))
      .step(activateAttachmentStep(state, 'b', 1))
      .step(activateAttachmentStep(state, 'c', 2));
    state = state.apply(tr);
    expect(attachmentInventory(state).orderedIds).toEqual(['a', 'b', 'c']);
    expect(undoDepth(state)).toBe(1);
    state = applyUndo(state);
    expect(attachmentInventory(state).orderedIds).toEqual([]);
  });

  it('inserts a mixed attachment batch as one undoable editor transaction', () => {
    let state = createState();
    const tr = insertAttachmentsTransaction(state, [
      { attrs: { attId: 'image', name: 'shot.png', kind: 'image' }, reference: false },
      { attrs: { attId: 'file', name: 'spec.pdf', kind: 'file' }, reference: true },
      { attrs: { attId: 'pasted', name: 'paste.png', kind: 'image' }, reference: true },
    ]);
    expect(tr).not.toBeNull();
    state = state.apply(tr!);
    expect(attachmentInventory(state).orderedIds).toEqual(['image', 'file', 'pasted']);
    expect(attachmentRefCounts(state.doc).has('image')).toBe(false);
    expect(attachmentRefCounts(state.doc).get('file')).toBe(1);
    expect(attachmentRefCounts(state.doc).get('pasted')).toBe(1);
    expect(undoDepth(state)).toBe(1);
    state = applyUndo(state);
    expect(attachmentInventory(state).orderedIds).toEqual([]);
    expect(attachmentRefCounts(state.doc).size).toBe(0);
  });

  it('inserts each image attId once in clipboard order without deduping labels', () => {
    let state = createState();
    const tr = insertAttachmentsTransaction(state, [
      { attrs: { attId: 'a', name: 'same.png', kind: 'image' }, reference: true },
      { attrs: { attId: 'b', name: 'same.png', kind: 'image' }, reference: true },
      { attrs: { attId: 'a', name: 'same.png', kind: 'image' }, reference: true },
    ]);

    expect(tr).not.toBeNull();
    state = state.apply(tr!);
    const ids: string[] = [];
    state.doc.descendants((node) => {
      if (node.type === composerSchema.nodes.attachment) ids.push(node.attrs.attId as string);
    });
    expect(ids).toEqual(['a', 'b']);
    expect(attachmentRefCounts(state.doc).get('a')).toBe(1);
    expect(attachmentRefCounts(state.doc).get('b')).toBe(1);
    expect(attachmentInventory(state).orderedIds).toEqual(['a', 'b']);
  });

  it('removes a duplicate manual image query without adding a pill or deleting surrounding content', () => {
    const wire = '[Image 1](kimi-code-composer://attachments/image) before @logo after';
    let state = EditorState.create({
      schema: composerSchema,
      doc: textToDoc(wire, { reviveMentions: true, attachmentKindFor: () => 'image' }),
      plugins: [history(), createAttachmentInventoryPlugin(['image'])],
    });
    const queryStart = wire.indexOf('@logo');
    const tr = insertAttachmentsTransaction(state, [{
      attrs: { attId: 'image', name: 'Image 1', kind: 'image' },
      range: { start: queryStart, end: queryStart + '@logo'.length },
      reference: true,
    }]);

    expect(tr).not.toBeNull();
    state = state.apply(tr!);
    expect(docToText(state.doc)).toBe(wire.replace('@logo', ''));
    expect(attachmentRefCounts(state.doc).get('image')).toBe(1);

    const retry = insertAttachmentsTransaction(state, [{
      attrs: { attId: 'image', name: 'Image 1', kind: 'image' },
      pos: 0,
      reference: true,
    }]);
    expect(retry).toBeNull();
    expect(docToText(state.doc)).toBe(wire.replace('@logo', ''));
  });

  it('keeps ordinary file references repeatable', () => {
    const wire = '[spec.pdf](kimi-code-composer://attachments/file) @spec';
    let state = EditorState.create({
      schema: composerSchema,
      doc: textToDoc(wire, { reviveMentions: true }),
      plugins: [history(), createAttachmentInventoryPlugin(['file'])],
    });
    const queryStart = wire.indexOf('@spec');
    const tr = insertAttachmentsTransaction(state, [{
      attrs: { attId: 'file', name: 'spec.pdf', kind: 'file' },
      range: { start: queryStart, end: queryStart + '@spec'.length },
      reference: true,
    }]);

    expect(tr).not.toBeNull();
    state = state.apply(tr!);
    expect(attachmentRefCounts(state.doc).get('file')).toBe(2);
    expect(docToText(state.doc)).not.toContain('@spec');
  });

  it('replaces an @ query with an existing attachment reference in one undoable transaction', () => {
    let state = EditorState.create({
      schema: composerSchema,
      doc: textToDoc('before @logo after'),
      plugins: [history(), createAttachmentInventoryPlugin(['image'])],
    });
    const tr = insertAttachmentsTransaction(state, [{
      attrs: { attId: 'image', name: 'Image 1', kind: 'image' },
      range: { start: 7, end: 12 },
      reference: true,
    }]);

    expect(tr).not.toBeNull();
    state = state.apply(tr!);
    expect(docToText(state.doc)).toBe(
      'before [Image 1](kimi-code-composer://attachments/image) after',
    );
    expect(attachmentInventory(state).orderedIds).toEqual(['image']);

    state = applyUndo(state);
    expect(docToText(state.doc)).toBe('before @logo after');
    expect(attachmentInventory(state).orderedIds).toEqual(['image']);
  });

  it('keeps separately dispatched activations as distinct history events', () => {
    let state = createState();
    state = state.apply(state.tr.step(activateAttachmentStep(state, 'a')));
    state = state.apply(state.tr.step(activateAttachmentStep(state, 'b')));
    state = state.apply(state.tr.step(activateAttachmentStep(state, 'c')));
    expect(undoDepth(state)).toBe(3);
    state = applyUndo(state);
    expect(attachmentInventory(state).orderedIds).toEqual(['a', 'b']);
  });

  it('removes an attachment and every reference in one reversible event', () => {
    const text = '[shot.png](kimi-code-composer://attachments/a) and [shot.png](kimi-code-composer://attachments/a)';
    let state = EditorState.create({
      schema: composerSchema,
      doc: textToDoc(text, { reviveMentions: true }),
      plugins: [history(), createAttachmentInventoryPlugin(['a'])],
    });
    const tr = deactivateAttachmentTransaction(state, 'a');
    expect(tr).not.toBeNull();
    state = state.apply(tr!);
    expect(attachmentInventory(state).activeIds.has('a')).toBe(false);
    expect(attachmentRefCounts(state.doc).has('a')).toBe(false);
    expect(undoDepth(state)).toBe(1);

    state = applyUndo(state);
    expect(attachmentInventory(state).activeIds.has('a')).toBe(true);
    expect(attachmentRefCounts(state.doc).get('a')).toBe(2);
  });

  it('removing references leaves the underlying attachment active', () => {
    const text = '[shot.png](kimi-code-composer://attachments/a)';
    let state = EditorState.create({
      schema: composerSchema,
      doc: textToDoc(text, {
        reviveMentions: true,
        attachmentKindFor: () => 'image',
      }),
      plugins: [history(), createAttachmentInventoryPlugin(['a'])],
    });
    const tr = removeAttachmentReferencesTransaction(state, 'a');
    expect(tr).not.toBeNull();
    state = state.apply(tr!);
    expect(attachmentInventory(state).activeIds.has('a')).toBe(true);
    expect(attachmentRefCounts(state.doc).has('a')).toBe(false);
    state = applyUndo(state);
    expect(attachmentRefCounts(state.doc).get('a')).toBe(1);
  });

  it('deactivates an invisible file when its final pill is deleted and restores both with one undo', () => {
    const text = '[spec.pdf](kimi-code-composer://attachments/file)';
    let state = EditorState.create({
      schema: composerSchema,
      doc: textToDoc(text, { reviveMentions: true }),
      plugins: [history(), createAttachmentInventoryPlugin(['file'])],
    });
    state = state.apply(state.tr.delete(1, 2));
    expect(attachmentInventory(state).activeIds.has('file')).toBe(false);
    expect(attachmentRefCounts(state.doc).has('file')).toBe(false);
    expect(undoDepth(state)).toBe(1);

    state = applyUndo(state);
    expect(attachmentInventory(state).activeIds.has('file')).toBe(true);
    expect(attachmentRefCounts(state.doc).get('file')).toBe(1);
  });

  it('keeps media active when its final pill is deleted', () => {
    const text = '[shot.png](kimi-code-composer://attachments/image)';
    let state = EditorState.create({
      schema: composerSchema,
      doc: textToDoc(text, {
        reviveMentions: true,
        attachmentKindFor: () => 'image',
      }),
      plugins: [history(), createAttachmentInventoryPlugin(['image'])],
    });
    state = state.apply(state.tr.delete(1, 2));
    expect(attachmentInventory(state).activeIds.has('image')).toBe(true);
    expect(attachmentRefCounts(state.doc).has('image')).toBe(false);
  });

  it('does not put resource revision updates into history', () => {
    let state = createState();
    state = state.apply(
      state.tr
        .setMeta(attachmentInventoryKey, { type: 'resource-revision' })
        .setMeta('addToHistory', false),
    );
    expect(attachmentInventory(state).resourceRevision).toBe(1);
    expect(undoDepth(state)).toBe(0);
  });
});
