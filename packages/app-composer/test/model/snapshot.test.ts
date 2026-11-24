import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { composerSchema, attachmentNode, browserReferenceNode, mentionNode, quoteNode } from '../../src/model/schema';
import { composerSnapshotDocument, createComposerSnapshot, mergeComposerSnapshots, parseComposerSnapshot, withoutComposerSnapshotAttachments } from '../../src/model/snapshot';
import { docToText } from '../../src/model/documentCodec';
import type { BrowserCapture } from '@moonshot-ai/app-core/browser-reference';
import { composerPlugins } from '../../src/runtime/plugins';
import { attachmentInventory } from '../../src/features/attachment/inventory';
import type { AttachmentEntry } from '../../src/features/attachment/entry';

function media(attId: string): AttachmentEntry {
  return { attId, key: `blob:${attId}`, kind: 'image', name: `${attId}.png`, refCount: 0, uploading: false, fileId: `file-${attId}`, sessionId: 'session-example' };
}

function paragraph(...nodes: PMNode[]): PMNode {
  return composerSchema.node('paragraph', null, nodes);
}

describe('composer document snapshots', () => {
  it('round-trips browser references and their screenshot graph without embedding images in the node', () => {
    const capture: BrowserCapture = {
      version: 1, id: 'capture', ordinal: 1, label: 'Region 1', capturedAt: '2026-09-07T00:00:00.000Z',
      page: { url: 'https://example.test', title: 'Example' },
      target: { kind: 'region', bounds: { x: 0, y: 0, width: 50, height: 50 } },
      viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0, zoomFactor: 1, devicePixelRatio: 2 },
      screenshot: { attachmentId: 'screenshot', crop: { x: 0, y: 0, width: 50, height: 50 }, pixelWidth: 100, pixelHeight: 100 },
    };
    const doc = composerSchema.node('doc', null, [paragraph(browserReferenceNode({ refId: 'ref-a', label: capture.label }))]);
    const snapshot = createComposerSnapshot(doc, [media('screenshot')], ['screenshot'], {
      references: [{ id: 'ref-a', captureId: capture.id, comment: 'Comment' }], captures: [capture],
    });
    const parsed = parseComposerSnapshot(JSON.parse(JSON.stringify(snapshot)))!;
    expect(parsed.browserReferences).toEqual(snapshot.browserReferences);
    expect(parsed.browserCaptures).toEqual(snapshot.browserCaptures);
    expect(composerSnapshotDocument(parsed).eq(doc)).toBe(true);
    expect(parsed.doc.content![0]!.content![0]!.attrs).toEqual({ refId: 'ref-a', label: capture.label });

    const repeated = mergeComposerSnapshots([snapshot, snapshot])!;
    expect(repeated.browserCaptures?.map((entry) => entry.bindingId)).toEqual(['capture', 'capture']);
    expect(new Set(repeated.browserCaptures?.map((entry) => entry.id)).size).toBe(2);
    const again = parseComposerSnapshot(mergeComposerSnapshots([repeated, snapshot]))!;
    expect(again.browserCaptures?.map((entry) => entry.bindingId)).toEqual(['capture', 'capture', 'capture']);

    const missingCapture = { ...snapshot, browserCaptures: undefined };
    const merged = mergeComposerSnapshots([snapshot, missingCapture])!;
    expect(merged.browserReferences![0]!.captureId).not.toBe(merged.browserReferences![1]!.captureId);
    expect(merged.browserCaptures).toHaveLength(1);
    const restored = EditorState.create({ doc: composerSnapshotDocument(parsed), plugins: composerPlugins(parsed.attachments, undefined, parsed.attachmentOrder, parsed) });
    expect(attachmentInventory(restored).orderedIds).toEqual(['screenshot']);
  });

  it('drops chosen attachments and turns their inline pills into their names', () => {
    const doc = composerSchema.node('doc', null, [composerSchema.node('paragraph', null, [
      composerSchema.text('see '),
      attachmentNode({ attId: 'lost', name: 'lost.png', kind: 'image' }),
      composerSchema.text(' and '),
      attachmentNode({ attId: 'kept', name: 'kept.png', kind: 'image' }),
    ])]);
    const snapshot = createComposerSnapshot(doc, [media('lost'), media('kept'), media('order-only')], ['lost', 'kept', 'order-only']);
    const next = withoutComposerSnapshotAttachments(snapshot, new Set(['lost', 'order-only']));
    expect(next.attachments.map((entry) => entry.attId)).toEqual(['kept']);
    expect(next.attachmentOrder).toEqual(['kept']);
    const paragraph = composerSnapshotDocument(next).firstChild!;
    expect(paragraph.childCount).toBe(2);
    expect(paragraph.firstChild!.text).toBe('see lost.png and ');
    expect(paragraph.lastChild!.attrs.attId).toBe('kept');
    expect(parseComposerSnapshot(JSON.parse(JSON.stringify(next)))).toEqual(next);
    expect(withoutComposerSnapshotAttachments(snapshot, new Set(['absent']))).toBe(snapshot);
  });

  it('restores exact node kinds and attributes without interpreting ordinary text as mentions', () => {
    const doc = composerSchema.node('doc', null, [
      paragraph(
        composerSchema.text('Literal [readme](README.md), '),
        mentionNode({ kind: 'file', name: '稿件 [最终].md', path: 'docs/稿件 [最终].md' }),
        mentionNode({ kind: 'folder', name: 'src', path: 'src/' }),
        mentionNode({ kind: 'skill', name: 'review', path: '' }),
        mentionNode({ kind: 'session', name: '修复登录跳转', path: 'session_1' }),
        attachmentNode({ attId: 'image1', name: '图片 1', kind: 'image' }),
        quoteNode({ text: '原文\n带换行与 <tag>', source: 'a.ts:10', comment: '请调整 👩🏽‍💻' }),
      ),
      paragraph(),
    ]);
    const wire = JSON.stringify(createComposerSnapshot(doc, [media('image1')], ['image1']));
    const parsed = parseComposerSnapshot(JSON.parse(wire));
    expect(parsed).not.toBeNull();
    const restored = composerSnapshotDocument(parsed!);
    expect(restored.eq(doc)).toBe(true);
    expect(restored.firstChild!.firstChild!.isText).toBe(true);
    expect(restored.firstChild!.child(3).attrs.kind).toBe('skill');
    expect(restored.firstChild!.child(4).attrs).toMatchObject({ kind: 'session', path: 'session_1' });
    expect(restored.firstChild!.lastChild!.attrs.comment).toBe('请调整 👩🏽‍💻');
  });

  it('restores session mentions saved with the earlier <workspaceId>/<sessionId> path as the session id', () => {
    const doc = composerSchema.node('doc', null, [
      paragraph(mentionNode({ kind: 'session', name: '修复登录跳转', path: 'wd_app_0123456789ab/session_1' })),
    ]);
    const parsed = parseComposerSnapshot(JSON.parse(JSON.stringify(createComposerSnapshot(doc, [], []))))!;
    const restored = composerSnapshotDocument(parsed);
    expect(restored.firstChild!.firstChild!.attrs).toMatchObject({ kind: 'session', path: 'session_1' });
    expect(docToText(restored)).toBe('[修复登录跳转](kimi-code://sessions/session_1)');
  });

  it('restores media-only attachments and their order independently of inline reference order', () => {
    const doc = composerSchema.node('doc', null, [paragraph(attachmentNode({ attId: 'image1', name: '图片 2', kind: 'image' }))]);
    const entries = [media('image1'), media('image2'), media('inactive')];
    const snapshot = parseComposerSnapshot(JSON.parse(JSON.stringify(createComposerSnapshot(doc, entries, ['image2', 'image1']))))!;
    const state = EditorState.create({
      doc: composerSnapshotDocument(snapshot),
      plugins: composerPlugins(snapshot.attachments, undefined, snapshot.attachmentOrder),
    });
    expect(attachmentInventory(state).orderedIds).toEqual(['image2', 'image1']);
    expect(attachmentInventory(state).refCounts.get('image1')).toBe(1);
    expect(attachmentInventory(state).refCounts.has('image2')).toBe(false);
    expect(snapshot.attachments.map((entry) => entry.attId)).toEqual(['image1', 'image2']);
  });

  it('keeps missing media identities and rich nodes so the renderer can show an unavailable resource', () => {
    const doc = composerSchema.node('doc', null, [paragraph(attachmentNode({ attId: 'missing', name: '原截图', kind: 'image' }))]);
    const parsed = parseComposerSnapshot(createComposerSnapshot(doc, [], ['missing']))!;
    expect(parsed.attachmentOrder).toEqual(['missing']);
    expect(composerSnapshotDocument(parsed).firstChild!.firstChild!.attrs.kind).toBe('image');
    expect(parsed.attachments).toEqual([]);
  });

  it('detaches snapshots from later resource or node mutations and omits transient previews', () => {
    const entry = { ...media('image1'), previewUrl: 'blob:ephemeral', uploadProgress: 50, thumbnailUrl: 'data:image/png;base64,AA==' };
    const doc = composerSchema.node('doc', null, [paragraph(attachmentNode({ attId: 'image1', name: '原图', kind: 'image' }))]);
    const snapshot = createComposerSnapshot(doc, [entry], ['image1']);
    entry.name = 'changed';
    snapshot.doc.content![0]!.content![0]!.attrs!['name'] = 'changed snapshot';
    expect(doc.firstChild!.firstChild!.attrs.name).toBe('原图');
    expect(snapshot.attachments[0]!.name).toBe('image1.png');
    expect(snapshot.attachments[0]!.previewUrl).toBeUndefined();
    expect(snapshot.attachments[0]!.uploadProgress).toBeUndefined();
    expect(snapshot.attachments[0]!.thumbnailUrl).toBe(entry.thumbnailUrl);
  });

  it('turns interrupted uploads into recoverable errors on persisted snapshot hydration', () => {
    const snapshot = createComposerSnapshot(composerSchema.node('doc', null, [paragraph()]), [{ ...media('image1'), uploading: true, fileId: undefined }], ['image1']);
    const parsed = parseComposerSnapshot(snapshot)!;
    expect(parsed.attachments[0]).toMatchObject({ attId: 'image1', uploading: false, error: 'upload-interrupted' });
  });

  it.each([
    { type: 'unknown' },
    { type: 'mention', attrs: { kind: 'browser', name: 'x', path: 'x' } },
    { type: 'mention', attrs: { kind: 'file', name: {}, path: 'x' } },
    { type: 'quote', attrs: { text: 'x', comment: 42 } },
    { type: 'attachment', attrs: { attId: '', name: 'x', kind: 'image' } },
    { type: 'text', text: 'x', marks: [{ type: 'unknown' }] },
    { type: 'text', text: '' },
    { type: 'paragraph', content: [] },
  ])('rejects an invalid inline node atomically: %j', (node) => {
    expect(parseComposerSnapshot({ version: 1, doc: { type: 'doc', content: [{ type: 'paragraph', content: [node] }] }, attachments: [], attachmentOrder: [] })).toBeNull();
  });

  it('rejects unknown versions, duplicate resource identities, duplicate order and cyclic input', () => {
    const snapshot = createComposerSnapshot(composerSchema.node('doc', null, [paragraph()]), [media('image1')], ['image1']);
    expect(parseComposerSnapshot({ ...snapshot, version: 2 })).toBeNull();
    expect(parseComposerSnapshot({ ...snapshot, attachments: [media('image1'), media('image1')] })).toBeNull();
    expect(parseComposerSnapshot({ ...snapshot, attachmentOrder: ['image1', 'image1'] })).toBeNull();
    const cyclic = { ...snapshot, extra: {} };
    cyclic.extra = cyclic;
    expect(parseComposerSnapshot(cyclic)).toBeNull();
  });
});
