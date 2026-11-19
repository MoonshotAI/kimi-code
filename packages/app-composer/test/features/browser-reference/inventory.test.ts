import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { Slice } from 'prosemirror-model';
import { closeHistory, undo, redo } from 'prosemirror-history';
import type { BrowserCapture } from '@moonshot-ai/app-core/browser-reference';
import { composerSchema, docToText, textToDoc } from '../../../src/model';
import { composerPlugins } from '../../../src/runtime/plugins';
import { attachmentInventory } from '../../../src/features/attachment/inventory';
import { activeBrowserReferenceIds, browserReferenceInventory, insertBrowserReferenceTransaction, updateBrowserReferenceTransaction } from '../../../src/features/browser-reference/inventory';
import { browserTargetName } from '../../../src/features/browser-reference/name';
import { buildAttachmentClipboardPaste, buildComposerClipboardCopy } from '../../../src/features/attachment/clipboard';
import type { AttachmentEntry } from '../../../src/features/attachment/entry';

const capture: BrowserCapture = {
  version: 1, id: 'capture-example', ordinal: 1, label: '按钮：保存', capturedAt: '2026-09-07T00:00:00.000Z',
  page: { url: 'https://example.test/settings', title: 'Settings' },
  target: { kind: 'element', tagName: 'button', accessibleName: '保存', bounds: { x: 10, y: 10, width: 100, height: 30 } },
  viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0, zoomFactor: 1, devicePixelRatio: 2 },
  screenshot: { attachmentId: 'screenshot', crop: { x: 10, y: 10, width: 100, height: 30 }, pixelWidth: 200, pixelHeight: 60 },
};

function initialState(): EditorState {
  return EditorState.create({ schema: composerSchema, doc: textToDoc(''), plugins: composerPlugins() });
}

function removeReference(state: EditorState, id: string): EditorState {
  let position = -1;
  state.doc.descendants((node, pos) => {
    if (node.type === composerSchema.nodes.browser_reference && node.attrs.refId === id) position = pos;
  });
  expect(position).toBeGreaterThanOrEqual(0);
  return state.apply(closeHistory(state.tr.delete(position, position + 1)));
}

describe('browser reference editor inventory', () => {
  it('omits screenshots only after every active reference opts out, and restores them on undo', () => {
    let state = initialState();
    for (const id of ['ref-a', 'ref-b']) state = state.apply(closeHistory(insertBrowserReferenceTransaction(state, capture, { id, captureId: capture.id })));
    state = state.apply(closeHistory(updateBrowserReferenceTransaction(state, 'ref-a', '', false)!));
    expect(attachmentInventory(state).orderedIds).toEqual(['screenshot']);
    state = state.apply(closeHistory(updateBrowserReferenceTransaction(state, 'ref-b', '', false)!));
    expect(attachmentInventory(state).orderedIds).toEqual([]);
    expect(browserReferenceInventory(state).captures.get(capture.id)?.screenshot).toEqual(capture.screenshot);
    expect(undo(state, (tr) => { state = state.apply(tr); })).toBe(true);
    expect(attachmentInventory(state).orderedIds).toEqual(['screenshot']);
    expect(browserReferenceInventory(state).references.get('ref-a')?.includeScreenshot).toBe(false);
    expect(redo(state, (tr) => { state = state.apply(tr); })).toBe(true);
    expect(attachmentInventory(state).orderedIds).toEqual([]);
  });

  it('keeps region screenshots active even when a restored reference attempts to omit them', () => {
    let state = initialState();
    const region: BrowserCapture = { ...capture, target: { kind: 'region', bounds: capture.target.bounds } };
    state = state.apply(insertBrowserReferenceTransaction(state, region, { id: 'ref-a', captureId: region.id, includeScreenshot: false }));
    expect(attachmentInventory(state).orderedIds).toEqual(['screenshot']);
    state = state.apply(updateBrowserReferenceTransaction(state, 'ref-a', 'Region comment', false)!);
    expect(browserReferenceInventory(state).references.get('ref-a')?.includeScreenshot).toBe(true);
    expect(attachmentInventory(state).orderedIds).toEqual(['screenshot']);
  });
  it('ignores a late comment edit after deletion without changing what Undo restores', () => {
    let state = initialState();
    state = state.apply(closeHistory(insertBrowserReferenceTransaction(state, capture, { id: 'ref-a', captureId: capture.id, comment: 'Original' })));
    state = removeReference(state, 'ref-a');
    expect(updateBrowserReferenceTransaction(state, 'ref-a', 'Late dialog edit')).toBeNull();
    expect(undo(state, (tr) => { state = state.apply(tr); })).toBe(true);
    expect(activeBrowserReferenceIds(state.doc).has('ref-a')).toBe(true);
    expect(browserReferenceInventory(state).references.get('ref-a')?.comment).toBe('Original');
  });

  it('copies source and comment as readable text and pastes an independently editable reference', () => {
    let state = initialState();
    state = state.apply(closeHistory(insertBrowserReferenceTransaction(state, capture, { id: 'ref-a', captureId: capture.id, comment: 'Original comment' })));
    const image: AttachmentEntry = { attId: 'screenshot', key: 'blob:screenshot', kind: 'image', name: 'capture.png', uploading: false, refCount: 0, fileId: 'file-example' };
    const copy = buildComposerClipboardCopy(Slice.maxOpen(state.doc.content), () => image, browserReferenceInventory(state))!;
    expect(copy.plain).toContain('按钮：保存');
    expect(copy.plain).toContain(capture.page.url);
    expect(copy.plain).toContain('Original comment');
    const paste = buildAttachmentClipboardPaste(state, copy.flavor, { entries: [image], upsert: () => {} })!;
    state = state.apply(closeHistory(paste));
    const ids = [...activeBrowserReferenceIds(state.doc)];
    expect(ids).toHaveLength(2);
    expect(ids[1]).not.toBe('ref-a');
    expect(browserReferenceInventory(state).captures.size).toBe(1);
    expect(attachmentInventory(state).orderedIds).toEqual(['screenshot']);
    state = state.apply(closeHistory(updateBrowserReferenceTransaction(state, ids[1]!, 'Copied comment')!));
    expect(browserReferenceInventory(state).references.get('ref-a')?.comment).toBe('Original comment');
    expect(browserReferenceInventory(state).references.get(ids[1]!)?.comment).toBe('Copied comment');
  });

  it('uses actual accessible names and short text but does not invent names for containers', () => {
    const bounds = { x: 0, y: 0, width: 100, height: 30 };
    expect(browserTargetName({ kind: 'element', tagName: 'button', accessibleName: '保存', text: 'Other text', bounds })).toEqual({ kind: 'button', name: '保存' });
    expect(browserTargetName({ kind: 'element', tagName: 'h2', text: '账户设置', bounds })).toEqual({ kind: 'heading', name: '账户设置' });
    expect(browserTargetName({ kind: 'element', tagName: 'button', bounds })).toEqual({ kind: 'button' });
    expect(browserTargetName({ kind: 'element', tagName: 'div', text: 'Many unrelated child labels', bounds })).toEqual({ kind: 'element' });
    expect(browserTargetName({ kind: 'element', tagName: 'p', text: 'Long text '.repeat(30), bounds })).toEqual({ kind: 'element' });
    expect(browserTargetName({ kind: 'region', bounds })).toEqual({ kind: 'region' });
  });

  it('inserts a rich reference and activates its screenshot in the same undoable action', () => {
    let state = initialState();
    state = state.apply(closeHistory(insertBrowserReferenceTransaction(state, capture, { id: 'ref-a', captureId: capture.id, comment: '改文字' })));
    expect(state.doc.firstChild!.firstChild!.type.name).toBe('browser_reference');
    expect(attachmentInventory(state).orderedIds).toEqual(['screenshot']);
    expect(browserReferenceInventory(state).references.get('ref-a')?.comment).toBe('改文字');
    expect(docToText(state.doc)).toContain('kimi-code-composer://browser-references/ref-a');
    expect(undo(state, (tr) => { state = state.apply(tr); })).toBe(true);
    expect(activeBrowserReferenceIds(state.doc).size).toBe(0);
    expect(attachmentInventory(state).orderedIds).toEqual([]);
    expect(redo(state, (tr) => { state = state.apply(tr); })).toBe(true);
    expect(activeBrowserReferenceIds(state.doc)).toEqual(new Set(['ref-a']));
    expect(attachmentInventory(state).orderedIds).toEqual(['screenshot']);
  });

  it('shares a capture while keeping each reference comment independent and undoable', () => {
    let state = initialState();
    for (const id of ['ref-a', 'ref-b']) state = state.apply(closeHistory(insertBrowserReferenceTransaction(state, capture, { id, captureId: capture.id, comment: id })));
    expect(attachmentInventory(state).orderedIds).toEqual(['screenshot']);
    state = state.apply(closeHistory(updateBrowserReferenceTransaction(state, 'ref-a', 'new comment')!));
    expect(browserReferenceInventory(state).references.get('ref-a')?.comment).toBe('new comment');
    expect(browserReferenceInventory(state).references.get('ref-b')?.comment).toBe('ref-b');
    undo(state, (tr) => { state = state.apply(tr); });
    expect(browserReferenceInventory(state).references.get('ref-a')?.comment).toBe('ref-a');
    expect(browserReferenceInventory(state).references.get('ref-b')?.comment).toBe('ref-b');
  });

  it('keeps shared screenshots until the last reference is removed and restores them on undo', () => {
    let state = initialState();
    for (const id of ['ref-a', 'ref-b']) state = state.apply(closeHistory(insertBrowserReferenceTransaction(state, capture, { id, captureId: capture.id })));
    state = removeReference(state, 'ref-a');
    expect(attachmentInventory(state).orderedIds).toEqual(['screenshot']);
    state = removeReference(state, 'ref-b');
    expect(attachmentInventory(state).orderedIds).toEqual([]);
    undo(state, (tr) => { state = state.apply(tr); });
    expect(activeBrowserReferenceIds(state.doc)).toEqual(new Set(['ref-b']));
    expect(attachmentInventory(state).orderedIds).toEqual(['screenshot']);
  });

  it('replaces only the requested @ token and refuses to reuse or mutate identities', () => {
    let state = EditorState.create({ doc: textToDoc('before @save after'), plugins: composerPlugins() });
    state = state.apply(insertBrowserReferenceTransaction(state, capture, { id: 'ref-a', captureId: capture.id }, { start: 7, end: 12 }));
    expect(docToText(state.doc)).toMatch(/^before \[按钮：保存\].* after$/);
    expect(() => insertBrowserReferenceTransaction(state, capture, { id: 'ref-a', captureId: capture.id })).toThrow('identity');
    expect(() => insertBrowserReferenceTransaction(state, { ...capture, label: 'changed' }, { id: 'ref-b', captureId: capture.id })).toThrow('immutable');
    expect(browserReferenceInventory(state).captures.get(capture.id)?.label).toBe('按钮：保存');
  });
});

it('retains the native binding when a pasted capture conflicts with a local record', () => {
  let source = initialState();
  source = source.apply(insertBrowserReferenceTransaction(source, capture, { id: 'source-ref', captureId: capture.id }));
  const copied = buildComposerClipboardCopy(Slice.maxOpen(source.doc.content), () => undefined, browserReferenceInventory(source))!;
  let destination = initialState();
  destination = destination.apply(insertBrowserReferenceTransaction(destination, { ...capture, label: 'Existing label' }, { id: 'existing-ref', captureId: capture.id }));
  const paste = buildAttachmentClipboardPaste(destination, copied.flavor);
  expect(paste).not.toBeNull();
  destination = destination.apply(paste!);
  const remapped = [...browserReferenceInventory(destination).captures.values()].find((entry) => entry.id !== capture.id);
  expect(remapped?.bindingId).toBe(capture.id);
});
