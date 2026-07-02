import { describe, it, expect } from 'vitest';

import { ImageAttachmentStore } from '#/tui/utils/image-attachment-store';
import { extractMediaAttachments } from '#/tui/utils/image-placeholder';

function storeWith(
  bytes: Uint8Array,
  width = 640,
  height = 480,
): { store: ImageAttachmentStore; placeholder: string } {
  const store = new ImageAttachmentStore();
  const att = store.addImage(bytes, 'image/png', width, height);
  return { store, placeholder: att.placeholder };
}

describe('extractMediaAttachments', () => {
  it('returns no parts and hasMedia=false for plain text', () => {
    const store = new ImageAttachmentStore();
    const r = extractMediaAttachments('hello world', store);
    expect(r.hasMedia).toBe(false);
    expect(r.parts).toEqual([]);
    expect(r.imageAttachmentIds).toEqual([]);
    expect(r.videoAttachmentIds).toEqual([]);
  });

  it('extracts a single matching placeholder into an image content part', () => {
    const { store, placeholder } = storeWith(new Uint8Array([0xaa, 0xbb]));
    const r = extractMediaAttachments(`describe ${placeholder} please`, store);
    expect(r.hasMedia).toBe(true);
    expect(r.imageAttachmentIds).toEqual([1]);
    expect(r.parts).toEqual([
      { type: 'text', text: 'describe ' },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,qrs=' } },
      { type: 'text', text: ' please' },
    ]);
  });

  it('keeps matched-placeholder order with multiple images', () => {
    const store = new ImageAttachmentStore();
    const a = store.addImage(new Uint8Array([1]), 'image/png', 10, 10);
    const b = store.addImage(new Uint8Array([2]), 'image/png', 20, 20);
    const text = `first ${a.placeholder} then ${b.placeholder} end`;
    const r = extractMediaAttachments(text, store);
    expect(r.imageAttachmentIds).toEqual([1, 2]);
    expect(r.parts).toEqual([
      { type: 'text', text: 'first ' },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AQ==' } },
      { type: 'text', text: ' then ' },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,Ag==' } },
      { type: 'text', text: ' end' },
    ]);
  });

  it('keeps matched-placeholder order with mixed image and video attachments', () => {
    const store = new ImageAttachmentStore();
    const img = store.addImage(new Uint8Array([1]), 'image/png', 10, 10);
    const vid = store.addVideo('video/quicktime', '/tmp/clip.mov');
    const text = `first ${img.placeholder} then ${vid.placeholder} end`;
    const r = extractMediaAttachments(text, store);
    expect(r.imageAttachmentIds).toEqual([1]);
    expect(r.videoAttachmentIds).toEqual([2]);
    expect(r.parts).toEqual([
      { type: 'text', text: 'first ' },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AQ==' } },
      { type: 'text', text: ' then <video path="/tmp/clip.mov"></video> end' },
    ]);
  });

  it('leaves unresolved (typed by hand) placeholders as literal text', () => {
    const store = new ImageAttachmentStore();
    const r = extractMediaAttachments('try [image #999 (1×1)] and [video #42 clip.mov] now', store);
    expect(r.hasMedia).toBe(false);
    expect(r.parts).toEqual([]);
  });

  it('uses pasted image bytes in data URLs', () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const { store, placeholder } = storeWith(bytes);
    const r = extractMediaAttachments(placeholder, store);
    expect(r.parts).toHaveLength(1);
    expect(r.parts[0]).toEqual({
      type: 'image_url',
      imageUrl: { url: 'data:image/png;base64,iVBORw==' },
    });
  });

  it('escapes media paths in generated tags', () => {
    const store = new ImageAttachmentStore();
    const att = store.addVideo('video/mp4', '/tmp/a&"<>.mp4', 'sample.mp4');
    const r = extractMediaAttachments(att.placeholder, store);
    expect(r.parts).toEqual([
      { type: 'text', text: '<video path="/tmp/a&amp;&quot;&lt;&gt;.mp4"></video>' },
    ]);
  });

  it('expands video placeholders backed by local files to readMediaFile video tags', () => {
    const store = new ImageAttachmentStore();
    const att = store.addVideo('video/mp4', '/tmp/sample.mp4');
    const r = extractMediaAttachments(att.placeholder, store);
    expect(r.hasMedia).toBe(true);
    expect(r.videoAttachmentIds).toEqual([1]);
    expect(r.parts).toEqual([{ type: 'text', text: '<video path="/tmp/sample.mp4"></video>' }]);
  });

  it('inserts a compression caption before an image that was compressed at paste time', () => {
    const store = new ImageAttachmentStore();
    const att = store.addImage(new Uint8Array([1, 2, 3]), 'image/png', 2000, 2000, {
      path: '/tmp/kimi-code-original-images/abc.png',
      width: 2600,
      height: 2600,
      byteLength: 123456,
      mime: 'image/png',
    });

    const r = extractMediaAttachments(`look ${att.placeholder}`, store);

    expect(r.parts).toHaveLength(2);
    const caption = r.parts[0];
    if (caption?.type !== 'text') throw new Error('expected leading text part');
    expect(caption.text).toContain('Image compressed');
    expect(caption.text).toContain('2600x2600');
    expect(caption.text).toContain('/tmp/kimi-code-original-images/abc.png');
    expect(r.parts[1]).toEqual({
      type: 'image_url',
      imageUrl: { url: 'data:image/png;base64,AQID' },
    });
  });

  it('notes an unpreserved original when persistence failed at paste time', () => {
    const store = new ImageAttachmentStore();
    const att = store.addImage(new Uint8Array([1]), 'image/png', 2000, 2000, {
      path: null,
      width: 2600,
      height: 2600,
      byteLength: 123456,
      mime: 'image/png',
    });

    const r = extractMediaAttachments(att.placeholder, store);

    const caption = r.parts[0];
    if (caption?.type !== 'text') throw new Error('expected leading text part');
    expect(caption.text).toMatch(/not preserved/i);
  });

  it('adds no caption for an uncompressed image attachment', () => {
    const { store, placeholder } = storeWith(new Uint8Array([0xaa]));
    const r = extractMediaAttachments(placeholder, store);
    expect(r.parts).toHaveLength(1);
    expect(r.parts[0]?.type).toBe('image_url');
  });
});
