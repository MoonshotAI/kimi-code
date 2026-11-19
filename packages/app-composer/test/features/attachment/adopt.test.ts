import { describe, expect, it } from 'vitest';
import {
  adoptAttachment,
  type AttachmentAdoptionEditor,
} from '../../../src/features/attachment/adopt';
import type { AttachmentAttrs } from '../../../src/model';
import type { AttachmentEntry } from '../../../src/features/attachment/entry';

function editor(initialText: string) {
  const textInsertions: Array<{ offset: number; text: string }> = [];
  const attachments: Array<{ attrs: AttachmentAttrs; pos?: number }> = [];
  const entries: AttachmentEntry[] = [];
  const value: AttachmentAdoptionEditor = {
    getText: () => initialText,
    getAttachmentEntries: () => entries,
    insertTextAt: (offset, text) => textInsertions.push({ offset, text }),
    insertAttachment: (attrs, pos) => attachments.push({ attrs, pos }),
    upsertAttachmentEntry: (entry) => entries.push(entry),
  };
  return { value, textInsertions, attachments, entries };
}

describe('adoptAttachment', () => {
  it('adds a separator before appending to non-whitespace text', () => {
    const target = editor('hello');
    const attId = adoptAttachment(target.value, {
      kind: 'file',
      name: 'notes.md',
      size: 12,
      uploading: false,
      fileId: 'file-1',
    });

    expect(target.textInsertions).toEqual([{ offset: 5, text: ' ' }]);
    expect(target.attachments).toEqual([
      { attrs: { attId, name: 'notes.md', kind: 'file' }, pos: 6 },
    ]);
    expect(target.entries).toEqual([
      {
        attId,
        key: `blob:${attId}`,
        kind: 'file',
        name: 'notes.md',
        size: 12,
        mediaType: undefined,
        refCount: 0,
        uploading: false,
        fileId: 'file-1',
      },
    ]);
  });

  it('inserts before the separator at an explicit anchor', () => {
    const target = editor('hello world');
    const attId = adoptAttachment(target.value, {
      kind: 'image',
      name: 'image.png',
      uploading: true,
    }, 5);

    expect(target.textInsertions).toEqual([{ offset: 5, text: ' ' }]);
    expect(target.attachments).toEqual([
      { attrs: { attId, name: 'image.png', kind: 'image' }, pos: 5 },
    ]);
    expect(target.entries[0]).toMatchObject({
      attId,
      key: `blob:${attId}`,
      kind: 'image',
      uploading: true,
    });
  });

  it('does not add a separator to empty or whitespace-terminated text', () => {
    for (const text of ['', 'hello ']) {
      const target = editor(text);
      adoptAttachment(target.value, {
        kind: 'video',
        name: 'clip.mp4',
        uploading: false,
      });
      expect(target.textInsertions).toEqual([]);
      expect(target.attachments[0]?.pos).toBe(text.length);
    }
  });

  it('uses a generated stable name for media references while retaining the original file name', () => {
    const target = editor('compare');
    target.entries.push({
      attId: 'existing',
      key: 'blob:existing',
      kind: 'image',
      name: 'first.png',
      mediaOrdinal: 2,
      refCount: 0,
      uploading: false,
    });

    const attId = adoptAttachment(target.value, {
      kind: 'image',
      name: 'second.png',
      uploading: false,
      mediaName: (ordinal) => `Image ${ordinal}`,
    });

    expect(target.attachments.at(-1)?.attrs).toEqual({
      attId,
      name: 'Image 3',
      kind: 'image',
    });
    expect(target.entries.at(-1)).toMatchObject({
      attId,
      name: 'second.png',
      mediaOrdinal: 3,
    });
  });
});
