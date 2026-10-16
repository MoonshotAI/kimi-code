import { describe, expect, it } from 'vitest';

import { ImageAttachmentStore } from '#/tui/utils/image-attachment-store';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

describe('ImageAttachmentStore snapshot/restore', () => {
  it('round-trips attachments, id sequence, and staging retains across clear()', () => {
    const store = new ImageAttachmentStore();
    const image = store.addImage(PNG, 'image/png', 640, 480, undefined, 'file-1', 1000);
    const video = store.addVideo('video/mp4', '/tmp/clip.mp4');
    store.retainFileIds([image.id, video.id]);

    const snapshot = store.snapshot();
    const orphaned = store.addImage(PNG, 'image/png', 1, 1);
    const deleted = store.clear();

    expect(deleted).toEqual([]);
    expect(store.get(image.id)).toBeUndefined();
    expect(store.get(video.id)).toBeUndefined();

    store.restore(snapshot);

    expect(store.get(image.id)).toBe(image);
    expect(store.get(video.id)).toBe(video);
    expect(store.get(orphaned.id)).toBeUndefined();

    const after = store.addImage(PNG, 'image/png', 2, 2);
    expect(after.id).toBe(orphaned.id);
    expect(after.placeholder).toContain(`#${String(orphaned.id)}`);

    const clearedAgain = store.clear();
    expect(clearedAgain).toEqual([]);
  });

  it('clear() drops unretained daemon uploads while the snapshot keeps the entries restorable', () => {
    const store = new ImageAttachmentStore();
    const retained = store.addImage(PNG, 'image/png', 10, 10, undefined, 'file-retained', 1000);
    const dropped = store.addImage(PNG, 'image/png', 10, 10, undefined, 'file-dropped', 1000);
    store.retainFileIds([retained.id]);

    const snapshot = store.snapshot();
    expect(store.clear()).toEqual(['file-dropped']);

    store.restore(snapshot);
    expect(store.get(retained.id)).toBe(retained);
    expect(store.get(dropped.id)).toBe(dropped);
  });
});
