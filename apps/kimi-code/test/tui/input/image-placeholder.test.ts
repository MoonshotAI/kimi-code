/**
 * Media placeholder expansion and rewrite contracts, including dispatch-time
 * fallback from expiring daemon uploads to bytes retained by the TUI.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import { parseDaemonFileUrl } from '@moonshot-ai/kimi-code-sdk';

import { KIMI_CODE_HOME_ENV } from '#/constant/app';
import { ImageAttachmentStore } from '#/tui/utils/image-attachment-store';
import {
  extractMediaAttachments,
  makeExtractionResendable,
  pendingMediaIngestions,
  persistOriginalImageSync,
  refreshExpiringImageFileRefs,
  resolveOriginalCaptions,
  rewriteMediaPlaceholders,
} from '#/tui/utils/image-placeholder';
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

type VideoUrlPart = { type: 'video_url'; videoUrl: { url: string } };

// Prompt-attached videos are emitted as a `video_url` part whose url is a
// bare `kimi-file://` daemon reference (the paste was uploaded at paste
// time); pull the url out for assertions.
function videoUrlFromParts(parts: unknown[]): string {
  const part = parts.find(
    (p): p is VideoUrlPart => (p as VideoUrlPart).type === 'video_url',
  );
  if (!part) throw new Error(`no video_url part found in: ${JSON.stringify(parts)}`);
  return part.videoUrl.url;
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
    store.completeVideo(vid, { fileId: 'file-v1' });
    const text = `first ${img.placeholder} then ${vid.placeholder} end`;
    const r = extractMediaAttachments(text, store);
    expect(r.imageAttachmentIds).toEqual([1]);
    expect(r.videoAttachmentIds).toEqual([2]);
    expect(r.parts).toEqual([
      { type: 'text', text: 'first ' },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AQ==' } },
      { type: 'text', text: ' then ' },
      { type: 'video_url', videoUrl: { url: 'kimi-file://file-v1' } },
      { type: 'text', text: ' end' },
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

  it('emits a bare kimi-file video_url part for an uploaded video', () => {
    const { cleanup } = setupTempCache();
    try {
      const store = new ImageAttachmentStore();
      const att = store.addVideo('video/mp4', '/tmp/sample.mp4');
      store.completeVideo(att, { fileId: 'file-v1' });
      const r = extractMediaAttachments(att.placeholder, store);
      expect(r.hasMedia).toBe(true);
      expect(r.videoAttachmentIds).toEqual([1]);
      expect(r.parts).toHaveLength(1);
      const part = r.parts[0] as VideoUrlPart;
      expect(part.type).toBe('video_url');
      // No cache copy and no `?path=`: the engine's prompt intake
      // materializes the session copy and rewrites the reference — the part
      // is self-contained.
      expect(parseDaemonFileUrl(part.videoUrl.url)).toEqual({ fileId: 'file-v1' });
      expect(existsSync(getCacheDir())).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('refuses a video whose upload is still in flight', () => {
    const store = new ImageAttachmentStore();
    const att = store.addVideo('video/mp4', '/tmp/sample.mp4');
    att.pending = new Promise<void>(() => undefined); // never settles
    expect(() => extractMediaAttachments(att.placeholder, store)).toThrow(
      /still uploading/,
    );
  });

  it('refuses a video whose upload failed or is missing', () => {
    const store = new ImageAttachmentStore();
    const att = store.addVideo('video/mp4', '/tmp/sample.mp4');
    expect(() => extractMediaAttachments(att.placeholder, store)).toThrow(
      /could not be uploaded/,
    );
  });

  it('refuses a video whose staged upload is too close to expiry', () => {
    const store = new ImageAttachmentStore();
    const att = store.addVideo('video/mp4', '/tmp/sample.mp4');
    store.completeVideo(att, {
      fileId: 'file-v1',
      fileExpiresAt: Date.now() + 1_000,
    });
    expect(() => extractMediaAttachments(att.placeholder, store)).toThrow(/expired/);
  });

  it('expands a compressed paste without a caption — captions are authored at dispatch', () => {
    const store = new ImageAttachmentStore();
    const att = store.addImage(new Uint8Array([1, 2, 3]), 'image/png', 2000, 2000, {
      bytes: new Uint8Array([9, 8, 7]),
      width: 2600,
      height: 2600,
      byteLength: 3,
      mime: 'image/png',
    });

    const r = extractMediaAttachments(`look ${att.placeholder}`, store);

    // Extraction stays persistence-free: no caption part, no original path.
    expect(r.parts).toEqual([
      { type: 'text', text: 'look ' },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AQID' } },
    ]);
    expect(att.original?.path).toBeUndefined();
  });

  it('adds no caption for an uncompressed image attachment', () => {
    const { store, placeholder } = storeWith(new Uint8Array([0xaa]));
    const r = extractMediaAttachments(placeholder, store);
    expect(r.parts).toHaveLength(1);
    expect(r.parts[0]?.type).toBe('image_url');
  });

  it('expands an uploaded (fileId) image into a bare kimi-file reference', () => {
    const { cleanup } = setupTempCache();
    try {
      const store = new ImageAttachmentStore();
      const att = store.addImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/png', 640, 480, undefined, 'file-1');
      const r = extractMediaAttachments(`describe ${att.placeholder} please`, store);
      expect(r.hasMedia).toBe(true);
      expect(r.imageAttachmentIds).toEqual([1]);
      // No tag text part and no `?path=`: the engine's prompt intake
      // materializes the session copy and rewrites the reference with its
      // path — the part is self-contained, no paired tag is authored.
      expect(r.parts).toEqual([
        { type: 'text', text: 'describe ' },
        { type: 'image_url', imageUrl: { url: 'kimi-file://file-1' } },
        { type: 'text', text: ' please' },
      ]);
      expect(parseDaemonFileUrl('kimi-file://file-1')).toEqual({ fileId: 'file-1' });
      // The edge stages no local copy for an uploaded image — the cache dir
      // is never even created.
      expect(existsSync(getCacheDir())).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('falls back to retained bytes when an uploaded image is too close to expiry', () => {
    const store = new ImageAttachmentStore();
    const att = store.addImage(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      'image/png',
      640,
      480,
      undefined,
      'file-1',
      1_060_000,
    );

    const parts = refreshExpiringImageFileRefs(
      [{ type: 'image_url', imageUrl: { url: 'kimi-file://file-1' } }],
      [att.id],
      store,
      1_000_000,
    );

    expect(parts).toEqual([
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,iVBORw==' } },
    ]);
    expect(att.fileId).toBeUndefined();
    expect(att.fileExpiresAt).toBeUndefined();
  });

  it('rebuilds an uploaded image as inline bytes for a new-session resend', () => {
    const { cleanup } = setupTempCache();
    try {
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      const store = new ImageAttachmentStore();
      const att = store.addImage(bytes, 'image/png', 640, 480, undefined, 'file-1');
      const extraction = extractMediaAttachments(att.placeholder, store);

      const resend = makeExtractionResendable(extraction);

      expect(resend.imageAttachmentIds).toEqual([]);
      expect(resend.parts).toContainEqual({
        type: 'image_url',
        imageUrl: { url: 'data:image/png;base64,iVBORw==' },
      });
    } finally {
      cleanup();
    }
  });

  it('rebuilds a compressed paste with its caption and original for a new-session resend', () => {
    const dir = makeTempDir();
    try {
      const store = new ImageAttachmentStore();
      const att = store.addImage(
        new Uint8Array([1, 2, 3]),
        'image/png',
        2000,
        1000,
        {
          bytes: new Uint8Array([9, 8, 7, 6]),
          width: 2600,
          height: 2600,
          byteLength: 4,
          mime: 'image/png',
        },
        'file-1',
      );
      // The session reset clears the store, so the snapshot is the only place
      // the original survives — the resend must persist it into the NEW
      // session's originals dir and author the caption itself.
      const extraction = extractMediaAttachments(att.placeholder, store);

      const resend = makeExtractionResendable(extraction, dir);

      expect(resend.imageAttachmentIds).toEqual([]);
      expect(resend.parts).toHaveLength(2);
      const caption = resend.parts[0];
      if (caption?.type !== 'text') throw new Error('expected caption text part');
      expect(caption.text).toContain('Image compressed');
      expect(caption.text).toContain('2600x2600');
      const files = readdirSync(dir);
      expect(files).toHaveLength(1);
      expect(caption.text).toContain(join(dir, files[0]!));
      expect(resend.parts[1]).toEqual({
        type: 'image_url',
        imageUrl: { url: 'data:image/png;base64,AQID' },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps expanding an uploaded image as a bare reference when the cache dir is broken', () => {
    const { cleanup } = setupTempCache();
    try {
      // A file at the cache dir path breaks local cache copies, but neither
      // form stages one: an uploaded image expands to a bare reference and
      // the inline (no fileId) form embeds its bytes.
      writeFileSync(getCacheDir(), 'occupied');
      const store = new ImageAttachmentStore();
      const uploaded = store.addImage(new Uint8Array([1]), 'image/png', 10, 10, undefined, 'file-1');
      const plain = store.addImage(new Uint8Array([2]), 'image/png', 20, 20);
      const r = extractMediaAttachments(`${uploaded.placeholder} and ${plain.placeholder}`, store);
      expect(r.imageAttachmentIds).toEqual([1, 2]);
      expect(r.parts).toEqual([
        { type: 'image_url', imageUrl: { url: 'kimi-file://file-1' } },
        { type: 'text', text: ' and ' },
        { type: 'image_url', imageUrl: { url: 'data:image/png;base64,Ag==' } },
      ]);
    } finally {
      cleanup();
    }
  });

  it('stages nothing when a later video refuses the submission', () => {
    const { cleanup } = setupTempCache();
    try {
      const store = new ImageAttachmentStore();
      const first = store.addVideo('video/mp4', '/tmp/first.mp4');
      store.completeVideo(first, { fileId: 'file-v1' });
      const missing = store.addVideo('video/mp4', '/tmp/missing.mp4');

      expect(() =>
        extractMediaAttachments(`${first.placeholder} ${missing.placeholder}`, store),
      ).toThrow(/could not be uploaded/);
      // The prompt path stages no cache copies at all, so the throw leaves
      // no local cleanup behind — the first video's daemon upload is owned
      // by its retain, not by a staging path.
      expect(existsSync(getCacheDir())).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe('resolveOriginalCaptions', () => {
  function storeWithOriginal(
    original?: {
      bytes: Uint8Array;
      width: number;
      height: number;
      byteLength: number;
      mime: string;
      path?: string;
    },
    fileId?: string,
  ) {
    const store = new ImageAttachmentStore();
    const att = store.addImage(
      new Uint8Array([1, 2, 3]),
      'image/png',
      2000,
      1000,
      original,
      fileId,
    );
    return { store, att };
  }

  it('persists the original into the given dir and inserts the caption before the image', () => {
    const dir = makeTempDir();
    try {
      const originalBytes = new Uint8Array([9, 8, 7, 6]);
      const { store, att } = storeWithOriginal({
        bytes: originalBytes,
        width: 2600,
        height: 2600,
        byteLength: originalBytes.length,
        mime: 'image/png',
      });
      const r = extractMediaAttachments(`look ${att.placeholder}`, store);

      const resolved = resolveOriginalCaptions(r.parts, r.imageAttachmentIds, store, dir);

      expect(att.original?.path?.startsWith(dir)).toBe(true);
      expect(readFileSync(att.original!.path!)).toEqual(Buffer.from(originalBytes));
      expect(resolved).toHaveLength(3);
      const caption = resolved[1];
      if (caption?.type !== 'text') throw new Error('expected caption text part');
      expect(caption.text).toContain('Image compressed');
      expect(caption.text).toContain('2600x2600');
      expect(caption.text).toContain(att.original!.path!);
      expect(resolved[2]).toEqual({
        type: 'image_url',
        imageUrl: { url: 'data:image/png;base64,AQID' },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('releases the in-memory original bytes once persistence succeeds', () => {
    const dir = makeTempDir();
    try {
      const originalBytes = new Uint8Array([9, 8, 7, 6]);
      const { store, att } = storeWithOriginal({
        bytes: originalBytes,
        width: 2600,
        height: 2600,
        byteLength: originalBytes.length,
        mime: 'image/png',
      });
      const r = extractMediaAttachments(att.placeholder, store);
      resolveOriginalCaptions(r.parts, r.imageAttachmentIds, store, dir);

      // The on-disk copy is the original from here on; the caption still
      // renders the original size from the retained metadata.
      expect(att.original?.bytes).toBeUndefined();
      const again = resolveOriginalCaptions(
        r.parts,
        r.imageAttachmentIds,
        store,
        dir,
      );
      const caption = again[0];
      if (caption?.type !== 'text') throw new Error('expected caption text part');
      expect(caption.text).toContain('2600x2600');
      expect(caption.text).toContain('4 B');
      expect(caption.text).toContain(att.original!.path!);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('authors the caption before the bare kimi-file reference', () => {
    const dir = makeTempDir();
    try {
      const { store, att } = storeWithOriginal(
        { bytes: new Uint8Array([9, 9]), width: 2600, height: 2600, byteLength: 2, mime: 'image/png' },
        'file-2',
      );
      const r = extractMediaAttachments(att.placeholder, store);

      const resolved = resolveOriginalCaptions(r.parts, r.imageAttachmentIds, store, dir);

      expect(resolved).toHaveLength(2);
      const caption = resolved[0];
      if (caption?.type !== 'text') throw new Error('expected caption text part');
      expect(caption.text).toContain('Image compressed');
      expect(caption.text).toContain(att.original!.path!);
      expect(resolved[1]).toEqual({
        type: 'image_url',
        imageUrl: { url: 'kimi-file://file-2' },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refreshes an already-authored caption in place instead of duplicating it', () => {
    const dir = makeTempDir();
    try {
      const { store, att } = storeWithOriginal({
        bytes: new Uint8Array([9]),
        width: 2600,
        height: 2600,
        byteLength: 1,
        mime: 'image/png',
      });
      const r = extractMediaAttachments(att.placeholder, store);
      const once = resolveOriginalCaptions(r.parts, r.imageAttachmentIds, store, dir);

      const twice = resolveOriginalCaptions(once, r.imageAttachmentIds, store, dir);

      expect(twice).toHaveLength(2);
      expect(twice[0]?.type).toBe('text');
      expect(twice[1]?.type).toBe('image_url');
      // The content-addressed original was persisted exactly once.
      expect(att.original?.path?.startsWith(dir)).toBe(true);
      expect(readdirSync(dir)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reuses an already-persisted original path without rewriting the file', () => {
    const dir = makeTempDir();
    try {
      const existing = join(dir, 'already.png');
      writeFileSync(existing, 'orig');
      const { store, att } = storeWithOriginal({
        bytes: new Uint8Array([7, 7, 7]),
        width: 2600,
        height: 2600,
        byteLength: 3,
        mime: 'image/png',
        path: existing,
      });
      const r = extractMediaAttachments(att.placeholder, store);

      const resolved = resolveOriginalCaptions(r.parts, r.imageAttachmentIds, store, dir);

      const caption = resolved[0];
      if (caption?.type !== 'text') throw new Error('expected caption text part');
      expect(caption.text).toContain(existing);
      expect(readFileSync(existing, 'utf8')).toBe('orig');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('notes an unpreserved original when persistence fails, then retries at a later dispatch', () => {
    const dir = makeTempDir();
    try {
      // A file where the target directory must be created breaks persistence.
      const occupied = join(dir, 'occupied');
      writeFileSync(occupied, 'x');
      const { store, att } = storeWithOriginal({
        bytes: new Uint8Array([5, 5]),
        width: 2600,
        height: 2600,
        byteLength: 2,
        mime: 'image/png',
      });
      const r = extractMediaAttachments(att.placeholder, store);

      const failed = resolveOriginalCaptions(
        r.parts,
        r.imageAttachmentIds,
        store,
        join(occupied, 'sub'),
      );

      const caption = failed[0];
      if (caption?.type !== 'text') throw new Error('expected caption text part');
      expect(caption.text).toMatch(/not preserved/i);
      // The failure is not terminal: the path stays unset and the bytes are
      // retained, so a later dispatch retries the write.
      expect(att.original?.path).toBeUndefined();
      expect(att.original?.bytes).toBeDefined();

      const retried = resolveOriginalCaptions(r.parts, r.imageAttachmentIds, store, dir);

      expect(att.original?.path?.startsWith(dir)).toBe(true);
      const retryCaption = retried[0];
      if (retryCaption?.type !== 'text') throw new Error('expected caption text part');
      expect(retryCaption.text).toContain(att.original!.path!);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips the caption when ingestion landed after extraction (stale inline part)', () => {
    const dir = makeTempDir();
    try {
      const store = new ImageAttachmentStore();
      const rawBytes = new Uint8Array([1, 2, 3, 4]);
      // Extraction raced the background ingestion: the part encodes the raw
      // paste bytes…
      const att = store.addImage(rawBytes, 'image/png', 2600, 2600);
      const r = extractMediaAttachments(att.placeholder, store);
      // …then ingestion completed, recording the compressed form. Captioning
      // now would describe an image the model did not receive.
      store.completeImage(att, {
        bytes: new Uint8Array([1, 2, 3]),
        mime: 'image/png',
        width: 2000,
        height: 2000,
        original: { bytes: rawBytes, width: 2600, height: 2600, byteLength: 4, mime: 'image/png' },
      });

      const resolved = resolveOriginalCaptions(r.parts, r.imageAttachmentIds, store, dir);

      expect(resolved).toHaveLength(1);
      expect(resolved[0]?.type).toBe('image_url');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves images without an original untouched', () => {
    const { store, placeholder } = storeWith(new Uint8Array([0xaa]));
    const r = extractMediaAttachments(placeholder, store);
    const resolved = resolveOriginalCaptions(r.parts, r.imageAttachmentIds, store, undefined);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.type).toBe('image_url');
  });
});

describe('persistOriginalImageSync', () => {
  it('evicts the oldest originals once the store exceeds the size cap', () => {
    const dir = makeTempDir();
    try {
      const first = persistOriginalImageSync(new Uint8Array(6).fill(1), 'image/png', dir);
      expect(first).not.toBeNull();
      // Pin the first file far into the past so eviction order is deterministic.
      const old = new Date(Date.now() - 60_000);
      utimesSync(first!, old, old);

      const second = persistOriginalImageSync(new Uint8Array(6).fill(2), 'image/png', dir, 10);

      expect(second).not.toBeNull();
      expect(existsSync(first!)).toBe(false);
      expect(existsSync(second!)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('rewriteMediaPlaceholders', () => {
  it('returns plain text untouched with hasMedia=false', () => {
    const store = new ImageAttachmentStore();
    const r = rewriteMediaPlaceholders('just some args', store);
    expect(r.text).toBe('just some args');
    expect(r.hasMedia).toBe(false);
    expect(r.imageAttachmentIds).toEqual([]);
    expect(r.videoAttachmentIds).toEqual([]);
  });

  it('rewrites an image placeholder into a cache-path image tag', () => {
    const { cleanup } = setupTempCache();
    try {
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      const { store, placeholder } = storeWith(bytes);
      const r = rewriteMediaPlaceholders(`look at ${placeholder} please`, store);
      expect(r.hasMedia).toBe(true);
      expect(r.imageAttachmentIds).toEqual([1]);
      const m = /^look at <image path="([^"]+)"><\/image> please$/.exec(r.text);
      if (!m) throw new Error(`no image tag found in: ${r.text}`);
      expect(m[1]!.startsWith(getCacheDir())).toBe(true);
      expect(m[1]!.endsWith('.png')).toBe(true);
      expect(new Uint8Array(readFileSync(m[1]!))).toEqual(bytes);
    } finally {
      cleanup();
    }
  });

  it('rewrites a video placeholder into a cache-path video tag', () => {
    const { cleanup } = setupTempCache();
    const srcDir = makeTempDir();
    try {
      const srcVideo = join(srcDir, 'clip.mov');
      writeFileSync(srcVideo, 'video-bytes');
      const store = new ImageAttachmentStore();
      const att = store.addVideo('video/quicktime', srcVideo);
      const r = rewriteMediaPlaceholders(att.placeholder, store);
      expect(r.hasMedia).toBe(true);
      expect(r.videoAttachmentIds).toEqual([1]);
      const m = /<video path="([^"]+)"><\/video>/.exec(r.text);
      if (!m) throw new Error(`no video tag found in: ${r.text}`);
      expect(m[1]!.startsWith(getCacheDir())).toBe(true);
      expect(readFileSync(m[1]!, 'utf8')).toBe('video-bytes');
    } finally {
      cleanup();
      rmSync(srcDir, { recursive: true, force: true });
    }
  });

  it('leaves unresolved (typed by hand) placeholders as literal text', () => {
    const store = new ImageAttachmentStore();
    const text = 'try [image #999 (1×1)] and [video #42 clip.mov] now';
    const r = rewriteMediaPlaceholders(text, store);
    expect(r.text).toBe(text);
    expect(r.hasMedia).toBe(false);
  });

  it('preserves surrounding text verbatim across multiple attachments', () => {
    const { cleanup } = setupTempCache();
    try {
      const store = new ImageAttachmentStore();
      const a = store.addImage(new Uint8Array([1]), 'image/png', 10, 10);
      const b = store.addImage(new Uint8Array([2]), 'image/jpeg', 20, 20);
      const r = rewriteMediaPlaceholders(
        `first ${a.placeholder}   then ${b.placeholder} end`,
        store,
      );
      expect(r.imageAttachmentIds).toEqual([1, 2]);
      const tags = [...r.text.matchAll(/<image path="([^"]+)"><\/image>/g)];
      expect(tags).toHaveLength(2);
      expect(r.text.startsWith('first <image path=')).toBe(true);
      expect(r.text).toContain('>   then <image path=');
      expect(r.text.endsWith('> end')).toBe(true);
      expect(new Uint8Array(readFileSync(tags[0]![1]!))).toEqual(new Uint8Array([1]));
      expect(new Uint8Array(readFileSync(tags[1]![1]!))).toEqual(new Uint8Array([2]));
    } finally {
      cleanup();
    }
  });

  it("rewrites an image placeholder into an escape-proof plain reference in 'plain' style", () => {
    const { cleanup } = setupTempCache();
    try {
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      const { store, placeholder } = storeWith(bytes);
      const r = rewriteMediaPlaceholders(`look at ${placeholder}`, store, 'plain');
      expect(r.hasMedia).toBe(true);
      expect(r.imageAttachmentIds).toEqual([1]);
      // Skill args pass through XML escaping, so the reference must not
      // contain any tag/attribute boundary characters.
      expect(r.text).not.toMatch(/[<>&"]/);
      const m =
        /^look at Attached image file: (\S+) \(open it with ReadMediaFile\)$/.exec(r.text);
      if (!m) throw new Error(`no plain reference found in: ${r.text}`);
      expect(m[1]!.startsWith(getCacheDir())).toBe(true);
      expect(new Uint8Array(readFileSync(m[1]!))).toEqual(bytes);
    } finally {
      cleanup();
    }
  });

  it("rewrites a video placeholder into an escape-proof plain reference in 'plain' style", () => {
    const { cleanup } = setupTempCache();
    const srcDir = makeTempDir();
    try {
      const srcVideo = join(srcDir, 'clip.mov');
      writeFileSync(srcVideo, 'video-bytes');
      const store = new ImageAttachmentStore();
      const att = store.addVideo('video/quicktime', srcVideo);
      const r = rewriteMediaPlaceholders(att.placeholder, store, 'plain');
      expect(r.hasMedia).toBe(true);
      expect(r.videoAttachmentIds).toEqual([1]);
      expect(r.text).not.toMatch(/[<>&"]/);
      const m = /^Attached video file: (\S+) \(open it with ReadMediaFile\)$/.exec(r.text);
      if (!m) throw new Error(`no plain reference found in: ${r.text}`);
      expect(readFileSync(m[1]!, 'utf8')).toBe('video-bytes');
    } finally {
      cleanup();
      rmSync(srcDir, { recursive: true, force: true });
    }
  });

  it("sanitizes XML boundary chars out of plain-style video cache names", () => {
    const { cleanup } = setupTempCache();
    const srcDir = makeTempDir();
    try {
      // The video label keeps the original filename, and sanitizeVideoLabel
      // allows `<>&"`; skill args are XML-escaped, so the plain reference
      // would point at a path that no longer matches the file on disk.
      const srcVideo = join(srcDir, 'clip<1>&.mov');
      writeFileSync(srcVideo, 'video-bytes');
      const store = new ImageAttachmentStore();
      const att = store.addVideo('video/quicktime', srcVideo);
      const r = rewriteMediaPlaceholders(att.placeholder, store, 'plain');
      expect(r.text).not.toMatch(/[<>&"]/);
      const m = /^Attached video file: (\S+) \(open it with ReadMediaFile\)$/.exec(r.text);
      if (!m) throw new Error(`no plain reference found in: ${r.text}`);
      expect(readFileSync(m[1]!, 'utf8')).toBe('video-bytes');
    } finally {
      cleanup();
      rmSync(srcDir, { recursive: true, force: true });
    }
  });
});

describe('pendingMediaIngestions', () => {
  it('returns undefined for text without media placeholders', () => {
    const store = new ImageAttachmentStore();
    expect(pendingMediaIngestions('hello world', store, 5)).toBeUndefined();
  });

  it('returns undefined when no referenced image has a pending ingestion', () => {
    const { store, placeholder } = storeWith(new Uint8Array([0xaa, 0xbb]));
    expect(pendingMediaIngestions(`describe ${placeholder}`, store, 5)).toBeUndefined();
  });

  it('waits for a pending ingestion so extraction can use the daemon-ref form', async () => {
    const { store, placeholder } = storeWith(new Uint8Array([0xaa, 0xbb]));
    const att = store.get(1);
    if (att?.kind !== 'image') throw new Error('expected image attachment');
    let finish!: () => void;
    att.pending = new Promise<void>((resolve) => {
      finish = () => {
        // Complete like the background ingestion would: land the upload id,
        // then resolve and clear the pending marker.
        att.fileId = 'file-1';
        att.fileExpiresAt = Date.now() + 60 * 60 * 1000;
        att.pending = undefined;
        resolve();
      };
    });

    const waited = pendingMediaIngestions(`describe ${placeholder}`, store, 1_000);
    if (waited === undefined) throw new Error('expected a pending wait');
    let settled = false;
    void waited.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    finish();
    await waited;
    expect(settled).toBe(true);

    const r = extractMediaAttachments(`describe ${placeholder}`, store);
    const part = r.parts.find((p) => p.type === 'image_url');
    expect(part?.type).toBe('image_url');
    if (part?.type !== 'image_url') throw new Error('expected an image part');
    expect(parseDaemonFileUrl(part.imageUrl.url)?.fileId).toBe('file-1');
  });

  it('waits for a pending video upload so extraction can use the daemon-ref form', async () => {
    const store = new ImageAttachmentStore();
    const att = store.addVideo('video/mp4', '/tmp/clip.mp4');
    let finish!: () => void;
    att.pending = new Promise<void>((resolve) => {
      finish = () => {
        store.completeVideo(att, { fileId: 'file-v1' });
        resolve();
      };
    });

    const waited = pendingMediaIngestions(`watch ${att.placeholder}`, store, 1_000);
    if (waited === undefined) throw new Error('expected a pending wait');
    finish();
    await waited;

    const r = extractMediaAttachments(`watch ${att.placeholder}`, store);
    expect(videoUrlFromParts(r.parts)).toBe('kimi-file://file-v1');
  });

  it('bounds the wait by the timeout so a slow ingestion extracts to the inline form', async () => {
    const { store, placeholder } = storeWith(new Uint8Array([0xaa, 0xbb]));
    const att = store.get(1);
    if (att?.kind !== 'image') throw new Error('expected image attachment');
    att.pending = new Promise<void>(() => undefined); // never settles

    const start = Date.now();
    const waited = pendingMediaIngestions(`describe ${placeholder}`, store, 20);
    if (waited === undefined) throw new Error('expected a pending wait');
    await waited;
    expect(Date.now() - start).toBeLessThan(1_000);

    const r = extractMediaAttachments(`describe ${placeholder}`, store);
    const part = r.parts.find((p) => p.type === 'image_url');
    if (part?.type !== 'image_url') throw new Error('expected an image part');
    expect(part.imageUrl.url.startsWith('data:image/png;base64,')).toBe(true);
  });
});
