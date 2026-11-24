import { describe, expect, it } from 'vitest';
import { composerSchema, attachmentNode, quoteNode, createComposerSnapshot, composerSnapshotDocument } from '@moonshot-ai/app-composer/model';
import { composerSnapshotFromMetadata, mergePromptSnapshots, rebindComposerSnapshotMedia } from '../src/lib/composerMessageSnapshot';
import type { AttachmentEntry } from '@moonshot-ai/app-composer/features/attachment';

function snapshot(fileId: string, comment: string) {
  const entry: AttachmentEntry = { attId: 'shared', key: 'blob:shared', kind: 'image', name: 'Image', refCount: 1, uploading: false, fileId };
  const doc = composerSchema.node('doc', null, [composerSchema.node('paragraph', null, [
    attachmentNode({ attId: entry.attId, kind: 'image', name: 'Image' }),
    quoteNode({ text: 'Source', comment }),
  ])]);
  return createComposerSnapshot(doc, [entry], [entry.attId]);
}

describe('composer message snapshot metadata', () => {
  it('reconstructs multiple submitted rich documents without mixing colliding media ids', () => {
    const first = snapshot('file-a', 'First comment');
    const second = snapshot('file-b', 'Second comment');
    const merged = composerSnapshotFromMetadata([{ kimi_code_composer: first }, { kimi_code_composer: second }])!;
    const doc = composerSnapshotDocument(merged);
    const firstId = doc.child(0).child(0).attrs.attId;
    const secondId = doc.child(2).child(0).attrs.attId;
    expect(firstId).not.toBe(secondId);
    expect(merged.attachments.find((entry) => entry.attId === firstId)?.fileId).toBe('file-a');
    expect(merged.attachments.find((entry) => entry.attId === secondId)?.fileId).toBe('file-b');
    expect(doc.child(0).child(1).attrs.comment).toBe('First comment');
    expect(doc.child(2).child(1).attrs.comment).toBe('Second comment');
    expect(second.attachmentOrder).toEqual(['shared']);
    expect(merged.attachmentOrder).toEqual([firstId, secondId]);
  });

  it('keeps literal text and non-reference media when combining a plain prompt with a snapshot', () => {
    const merged = mergePromptSnapshots([
      { text: '[literal](example.md)', attachments: [{ kind: 'image', fileId: 'plain-image', name: 'plain.png' }] },
      { text: 'wire text', attachments: [], snapshot: snapshot('file-b', 'Comment') },
    ])!;
    const doc = composerSnapshotDocument(merged);
    expect(doc.firstChild!.firstChild!.isText).toBe(true);
    expect(doc.firstChild!.textContent).toBe('[literal](example.md)');
    expect(merged.attachments.map((entry) => entry.fileId)).toEqual(['plain-image', 'file-b']);
    expect(merged.attachmentOrder).toHaveLength(2);
  });

  it('keeps plain inputs before and after a rich prompt without interpreting literal Markdown', () => {
    const merged = composerSnapshotFromMetadata([{ display_text: '[literal](example.md)' }, { kimi_code_composer: snapshot('image', 'Comment') }, { display_text: 'last instruction' }])!;
    const doc = composerSnapshotDocument(merged);
    expect(doc.firstChild!.firstChild!.isText).toBe(true);
    expect(doc.firstChild!.textContent).toBe('[literal](example.md)');
    expect(doc.lastChild!.textContent).toBe('last instruction');
    expect(merged.attachments[0]?.fileId).toBe('image');
    expect(composerSnapshotFromMetadata([{ kimi_code_composer: snapshot('image', 'Comment') }, {}])).toBeNull();
  });

  it('does not invent rich metadata for ordinary non-composer prompts', () => {
    expect(mergePromptSnapshots([{ text: 'plain', attachments: [] }])).toBeUndefined();
    expect(composerSnapshotFromMetadata(undefined)).toBeNull();
    expect(composerSnapshotFromMetadata([{ unrelated: 1 }])).toBeNull();
    expect(composerSnapshotFromMetadata([{ kimi_code_composer: { version: 99 } }])).toBeNull();
    expect(composerSnapshotFromMetadata('invalid')).toBeNull();
    expect(composerSnapshotFromMetadata([null, 1, [], 'invalid'])).toBeNull();
  });

  it('rebinds a sent snapshot to canonical media in the current session without changing reference ids', () => {
    const original = snapshot('temporary-upload', 'Comment');
    const restored = rebindComposerSnapshotMedia(original, [{ kind: 'image', url: '/example', fileId: 'session-image', sessionId: 'forked-session' }]);
    expect(restored.attachments[0]).toMatchObject({ attId: 'shared', fileId: 'session-image', sessionId: 'forked-session' });
    expect(restored.doc).toEqual(original.doc);
    expect(original.attachments[0]!.fileId).toBe('temporary-upload');
  });

  it('does not attach an unrelated image when the message media list is incomplete', () => {
    const original = snapshot('original', 'Comment');
    const restored = rebindComposerSnapshotMedia(original, [{ kind: 'video', url: '/example', fileId: 'other' }]);
    expect(restored.attachments[0]!.fileId).toBe('original');
  });
});
