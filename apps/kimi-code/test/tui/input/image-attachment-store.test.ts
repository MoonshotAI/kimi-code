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

  it('clear() resets ids and empties storage', () => {
    const s = new ImageAttachmentStore();
    s.addImage(new Uint8Array(), 'image/png', 10, 10);
    s.addImage(new Uint8Array(), 'image/png', 10, 10);
    expect(s.size()).toBe(2);
    s.clear();
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
});
