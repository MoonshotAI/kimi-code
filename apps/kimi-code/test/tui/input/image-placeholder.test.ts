import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import { KIMI_CODE_HOME_ENV } from '#/constant/app';
import { ImageAttachmentStore } from '#/tui/utils/image-attachment-store';
import { extractMediaAttachments } from '#/tui/utils/image-placeholder';
import { getCacheDir } from '#/utils/paths';

function storeWith(
  bytes: Uint8Array,
  width = 640,
  height = 480,
): { store: ImageAttachmentStore; placeholder: string } {
  const store = new ImageAttachmentStore();
  const att = store.addImage(bytes, 'image/png', width, height);
  return { store, placeholder: att.placeholder };
}

/** Point `getCacheDir()` at a fresh temp home for the duration of a test. */
function setupTempCache(): { cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'kimi-home-'));
  const prev = process.env[KIMI_CODE_HOME_ENV];
  process.env[KIMI_CODE_HOME_ENV] = home;
  return {
    cleanup: () => {
      if (prev === undefined) delete process.env[KIMI_CODE_HOME_ENV];
      else process.env[KIMI_CODE_HOME_ENV] = prev;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'kimi-src-'));
}

type TextPart = { type: 'text'; text: string };

function videoPathFromParts(parts: unknown[]): string {
  const text = parts
    .filter((p): p is TextPart => (p as TextPart).type === 'text')
    .map((p) => p.text)
    .join('');
  const m = /<video path="([^"]+)"><\/video>/.exec(text);
  if (!m) throw new Error(`no video tag found in: ${text}`);
  return m[1]!;
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
    const { cleanup } = setupTempCache();
    const srcDir = makeTempDir();
    try {
      const srcVideo = join(srcDir, 'clip.mov');
      writeFileSync(srcVideo, 'video-bytes');
      const store = new ImageAttachmentStore();
      const img = store.addImage(new Uint8Array([1]), 'image/png', 10, 10);
      const vid = store.addVideo('video/quicktime', srcVideo);
      const text = `first ${img.placeholder} then ${vid.placeholder} end`;
      const r = extractMediaAttachments(text, store);
      expect(r.imageAttachmentIds).toEqual([1]);
      expect(r.videoAttachmentIds).toEqual([2]);
      expect(r.parts[0]).toEqual({ type: 'text', text: 'first ' });
      expect(r.parts[1]).toEqual({
        type: 'image_url',
        imageUrl: { url: 'data:image/png;base64,AQ==' },
      });
      const cachePath = videoPathFromParts(r.parts);
      expect(cachePath.startsWith(getCacheDir())).toBe(true);
      expect(readFileSync(cachePath, 'utf8')).toBe('video-bytes');
    } finally {
      cleanup();
      rmSync(srcDir, { recursive: true, force: true });
    }
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
    const { cleanup } = setupTempCache();
    const srcDir = makeTempDir();
    try {
      const srcVideo = join(srcDir, 'source.mp4');
      writeFileSync(srcVideo, 'x');
      const store = new ImageAttachmentStore();
      // The filename drives the cache label; `&` must be escaped in the attribute.
      const att = store.addVideo('video/mp4', srcVideo, 'a&b.mp4');
      const r = extractMediaAttachments(att.placeholder, store);
      expect(r.parts).toHaveLength(1);
      const text = (r.parts[0] as TextPart).text;
      expect(text).toMatch(/<video path="[^"]+a&amp;b\.mp4"><\/video>/);
    } finally {
      cleanup();
      rmSync(srcDir, { recursive: true, force: true });
    }
  });

  it('copies video placeholders into the cache and emits cache-path tags', () => {
    const { cleanup } = setupTempCache();
    const srcDir = makeTempDir();
    try {
      const srcVideo = join(srcDir, 'sample.mp4');
      writeFileSync(srcVideo, 'video-data');
      const store = new ImageAttachmentStore();
      const att = store.addVideo('video/mp4', srcVideo);
      const r = extractMediaAttachments(att.placeholder, store);
      expect(r.hasMedia).toBe(true);
      expect(r.videoAttachmentIds).toEqual([1]);
      const cachePath = videoPathFromParts(r.parts);
      // The tag points at the cache, not the original source path.
      expect(cachePath.startsWith(getCacheDir())).toBe(true);
      expect(cachePath).not.toBe(srcVideo);
      expect(readFileSync(cachePath, 'utf8')).toBe('video-data');
    } finally {
      cleanup();
      rmSync(srcDir, { recursive: true, force: true });
    }
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
