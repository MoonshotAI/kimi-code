import { describe, it, expect } from 'vitest';

import {
  ImageAttachmentStore,
  formatPlaceholder,
  formatVideoPlaceholder,
} from '#/tui/utils/image-attachment-store';

describe('ImageAttachmentStore', () => {
  it('assigns monotonically increasing ids starting at 1', () => {
    const s = new ImageAttachmentStore();
    const a = s.addImage(new Uint8Array([1]), 'image/png', 10, 20);
    const b = s.addVideo('video/quicktime', '/tmp/sample.mov');
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
  });

  it('builds the canonical placeholder string', () => {
    expect(formatPlaceholder(1, 640, 480)).toBe('[image #1 (640×480)]');
    expect(formatPlaceholder(42, 3840, 2160)).toBe('[image #42 (3840×2160)]');
  });

  it('builds video placeholders with sanitized labels', () => {
    expect(formatVideoPlaceholder(1, 'sample.mov')).toBe('[video #1 sample.mov]');
    expect(formatVideoPlaceholder(2, 'bad[name]\u0000.mov')).toBe('[video #2 bad_name__.mov]');
  });

  it('uses the video filename basename as the placeholder label', () => {
    const s = new ImageAttachmentStore();
    const att = s.addVideo('video/mp4', '/tmp/clips/sample.mp4');
    expect(att.filename).toBe('sample.mp4');
    expect(att.sourcePath).toBe('/tmp/clips/sample.mp4');
    expect(att.placeholder).toBe('[video #1 sample.mp4]');
  });

  it('get() returns stored attachment', () => {
    const s = new ImageAttachmentStore();
    const bytes = new Uint8Array([9, 8, 7]);
    const att = s.addImage(bytes, 'image/jpeg', 100, 200);
    expect(s.get(att.id)).toBe(att);
    expect(s.get(99)).toBeUndefined();
  });

  it('keeps pasted image bytes in memory', () => {
    const s = new ImageAttachmentStore();
    const bytes = new Uint8Array([9, 8, 7]);
    const att = s.addImage(bytes, 'image/jpeg', 100, 200);
    expect(att.bytes).toBe(bytes);
    expect(att.mime).toBe('image/jpeg');
  });

  it('completes a pending image without changing its attachment id', () => {
    const s = new ImageAttachmentStore();
    const att = s.addImage(new Uint8Array([1]), 'image/png', 10, 20);

    const completed = s.completeImage(att, {
      bytes: new Uint8Array([2, 3]),
      mime: 'image/jpeg',
      width: 30,
      height: 40,
      fileId: 'file-2',
    });

    expect(completed).toBe(att);
    expect(att.id).toBe(1);
    expect(att.bytes).toEqual(new Uint8Array([2, 3]));
    expect(att.mime).toBe('image/jpeg');
    expect(att.placeholder).toBe('[image #1 (30×40)]');
    const stale = att;
    s.clear();
    const fresh = s.addImage(new Uint8Array([9]), 'image/png', 2, 2);
    expect(s.completeImage(stale, {
      bytes: new Uint8Array([8]),
      mime: 'image/png',
      width: 3,
      height: 3,
    })).toBeUndefined();
    expect(fresh.bytes).toEqual(new Uint8Array([9]));
  });

  it('records the daemon file-store id when the paste was uploaded (v2)', () => {
    const s = new ImageAttachmentStore();
    const att = s.addImage(new Uint8Array([1]), 'image/png', 10, 20, undefined, 'file-abc');
    expect(att.fileId).toBe('file-abc');
  });

  it('leaves fileId undefined for attachments that were not uploaded', () => {
    const s = new ImageAttachmentStore();
    const att = s.addImage(new Uint8Array([1]), 'image/png', 10, 20);
    expect(att.fileId).toBeUndefined();
  });

  it('clear() resets ids and empties storage', () => {
    const s = new ImageAttachmentStore();
    s.addImage(new Uint8Array(), 'image/png', 10, 10, undefined, 'file-1');
    s.addImage(new Uint8Array(), 'image/png', 10, 10);
    expect(s.size()).toBe(2);
    expect(s.clear()).toEqual(['file-1']);
    expect(s.size()).toBe(0);
    const next = s.addImage(new Uint8Array(), 'image/png', 10, 10);
    expect(next.id).toBe(1);
  });

  it('remove() drops a single attachment without resetting ids', () => {
    const s = new ImageAttachmentStore();
    const a = s.addImage(new Uint8Array([1]), 'image/png', 10, 10);
    const b = s.addImage(new Uint8Array([2]), 'image/png', 10, 10);
    expect(s.size()).toBe(2);
    s.remove(a.id);
    expect(s.size()).toBe(1);
    expect(s.get(a.id)).toBeUndefined();
    expect(s.get(b.id)).toBe(b);
    // Unlike clear(), remove() must not reset the id counter.
    const next = s.addImage(new Uint8Array([3]), 'image/png', 10, 10);
    expect(next.id).toBe(3);
  });

  it('removeMany() drops many attachments at once', () => {
    const s = new ImageAttachmentStore();
    const a = s.addImage(new Uint8Array([1]), 'image/png', 10, 10);
    const b = s.addImage(new Uint8Array([2]), 'image/png', 10, 10);
    const c = s.addImage(new Uint8Array([3]), 'image/png', 10, 10);
    s.removeMany([a.id, c.id]);
    expect(s.size()).toBe(1);
    expect(s.get(b.id)).toBe(b);
    expect(s.get(a.id)).toBeUndefined();
    expect(s.get(c.id)).toBeUndefined();
  });

  it('transfers staging file ownership without dropping thumbnail bytes', () => {
    const s = new ImageAttachmentStore();
    const bytes = new Uint8Array([1, 2, 3]);
    const att = s.addImage(bytes, 'image/png', 10, 10, undefined, 'file-1');

    expect(s.takeFileIds([att.id])).toEqual(['file-1']);
    expect(att.fileId).toBeUndefined();
    expect(att.bytes).toBe(bytes);
    expect(s.takeFileIds([att.id])).toEqual([]);
  });

  it('keeps a daemon upload until every extracted message releases it', () => {
    const s = new ImageAttachmentStore();
    const att = s.addImage(new Uint8Array([1]), 'image/png', 10, 10, undefined, 'file-1');

    s.retainFileIds([att.id]);
    s.retainFileIds([att.id]);
    expect(s.takeFileIds([att.id])).toEqual([]);
    expect(att.fileId).toBe('file-1');
    expect(s.takeFileIds([att.id])).toEqual(['file-1']);
    expect(att.fileId).toBeUndefined();
  });

  it('releaseRetains consumes the retain but keeps the staged upload on the attachment', () => {
    const s = new ImageAttachmentStore();
    const att = s.addImage(new Uint8Array([1]), 'image/png', 10, 10, undefined, 'file-1');

    s.retainFileIds([att.id]);
    s.releaseRetains([att.id]);
    expect(att.fileId).toBe('file-1');
    // The retain is gone: a later take consumes the upload immediately.
    expect(s.takeFileIds([att.id])).toEqual(['file-1']);
    expect(att.fileId).toBeUndefined();
  });

  it('releaseRetains leaves retains held by other submissions untouched', () => {
    const s = new ImageAttachmentStore();
    const att = s.addImage(new Uint8Array([1]), 'image/png', 10, 10, undefined, 'file-1');

    s.retainFileIds([att.id]); // submission A queues
    s.retainFileIds([att.id]); // submission B queues
    s.releaseRetains([att.id]); // A is recalled into the editor
    s.retainFileIds([att.id]); // A's restored draft resubmits
    // A's consuming turn ends: one retain (B's) is still outstanding, so the
    // upload survives.
    expect(s.takeFileIds([att.id])).toEqual([]);
    expect(att.fileId).toBe('file-1');
    // B's turn ends: the last retain is gone, the upload is taken.
    expect(s.takeFileIds([att.id])).toEqual(['file-1']);
    expect(att.fileId).toBeUndefined();
  });

  it('completeVideo lands the daemon upload id and clears the pending marker', () => {
    const s = new ImageAttachmentStore();
    const att = s.addVideo('video/mp4', '/tmp/original.mp4');
    att.pending = Promise.resolve();

    const completed = s.completeVideo(att, { fileId: 'file-v1', fileExpiresAt: 123_000 });

    expect(completed).toBe(att);
    expect(att.fileId).toBe('file-v1');
    expect(att.fileExpiresAt).toBe(123_000);
    expect(att.pending).toBeUndefined();

    // A cleared attachment is not completed — the caller deletes the upload.
    s.clear();
    const stale = att;
    const fresh = s.addVideo('video/mp4', '/tmp/other.mp4');
    expect(s.completeVideo(stale, { fileId: 'file-v2' })).toBeUndefined();
    expect(fresh.fileId).toBeUndefined();
  });

  it('clear() keeps staged uploads that still have an outstanding retain', () => {
    const s = new ImageAttachmentStore();
    const img = s.addImage(new Uint8Array(), 'image/png', 10, 10, undefined, 'file-1');
    const vid = s.addVideo('video/mp4', '/tmp/a.mp4');
    s.completeVideo(vid, { fileId: 'file-2' });

    // The video's upload is still referenced by a stashed/queued draft; the
    // image's is not, so only the latter comes back for deletion.
    s.retainFileIds([vid.id]);
    expect(s.clear()).toEqual(['file-1']);
    expect(s.size()).toBe(0);
    expect(img.fileId).toBe('file-1');
  });

  it('takes a video upload through the same retain/take lifecycle as an image', () => {
    const s = new ImageAttachmentStore();
    const vid = s.addVideo('video/mp4', '/tmp/a.mp4');
    s.completeVideo(vid, { fileId: 'file-v1' });

    s.retainFileIds([vid.id]);
    s.retainFileIds([vid.id]);
    expect(s.takeFileIds([vid.id])).toEqual([]);
    expect(vid.fileId).toBe('file-v1');
    expect(s.takeFileIds([vid.id])).toEqual(['file-v1']);
    expect(vid.fileId).toBeUndefined();
  });
});
