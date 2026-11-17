import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Jimp } from 'jimp';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EditorKeyboardController,
  type EditorKeyboardHost,
} from '#/tui/controllers/editor-keyboard';
import { ImageAttachmentStore } from '#/tui/utils/image-attachment-store';
import { parseImageMeta } from '#/utils/image/image-mime';
import { ImageLimits, type KimiHarness } from '@moonshot-ai/kimi-code-sdk';

const { readClipboardMedia } = vi.hoisted(() => ({ readClipboardMedia: vi.fn() }));

vi.mock('#/utils/clipboard/clipboard-image', async (importActual) => {
  const actual = await importActual<typeof import('#/utils/clipboard/clipboard-image')>();
  return { ...actual, readClipboardMedia };
});

interface PasteHarness {
  readonly store: ImageAttachmentStore;
  readonly track: ReturnType<typeof vi.fn>;
  pasteImage(): Promise<void>;
  pasteImageRaw(): Promise<boolean>;
}

function createPasteHarness(
  options: {
    sessionDir?: string;
    imageLimits?: ImageLimits;
    uploadFile?: (
      data: Uint8Array,
      opts: { name: string; mimeType?: string; expiresInSec?: number },
    ) => Promise<{ id: string }>;
  } = {},
): PasteHarness {
  const editor: Record<string, ((...args: never[]) => unknown) | undefined> = {
    setHistoryFilter: vi.fn() as unknown as (...args: never[]) => unknown,
  };
  const store = new ImageAttachmentStore();
  const track = vi.fn();
  const host = {
    state: {
      editor,
      activeDialog: null,
      appState: { streamingPhase: 'idle', isCompacting: false },
      footer: { setTransientHint: vi.fn() },
      ui: { requestRender: vi.fn() },
    },
    session:
      options.sessionDir === undefined
        ? undefined
        : { summary: { sessionDir: options.sessionDir } },
    btwPanelController: { closeOrCancel: vi.fn(() => false) },
    track,
    showError: vi.fn(),
    openUndoSelector: vi.fn(),
    cancelRunningShellCommand: vi.fn(),
  } as unknown as EditorKeyboardHost;
  if (options.imageLimits !== undefined || options.uploadFile !== undefined) {
    (host as unknown as { harness: KimiHarness }).harness = {
      imageLimits: options.imageLimits,
      uploadFile: options.uploadFile,
    } as unknown as KimiHarness;
  }

  const controller = new EditorKeyboardController(host, store);
  controller.install();

  const pasteImageRaw = (): Promise<boolean> => {
    const handler = editor['onPasteImage'];
    if (handler === undefined) throw new Error('onPasteImage handler not installed');
    return (handler as () => Promise<boolean>)();
  };

  return {
    store,
    track,
    async pasteImage() {
      await pasteImageRaw();
      for (let id = 1; id <= store.size(); id++) {
        await store.get(id)?.pending;
      }
    },
    pasteImageRaw,
  };
}

async function solidPng(width: number, height: number): Promise<Uint8Array> {
  return new Uint8Array(
    await new Jimp({ width, height, color: 0x3366ccff }).getBuffer('image/png'),
  );
}

async function solidJpeg(width: number, height: number): Promise<Uint8Array> {
  return new Uint8Array(
    await new Jimp({ width, height, color: 0x3366ccff }).getBuffer('image/jpeg', { quality: 90 }),
  );
}

function uploadFileMock(id: string) {
  return vi.fn(async (
    _data: Uint8Array,
    _opts: { name: string; mimeType?: string; expiresInSec?: number },
  ) => ({ id, expires_at: '2030-01-02T03:04:05.000Z' }));
}

function withExifOrientation(jpeg: Uint8Array, orientation: number): Uint8Array {
  const tiff = Buffer.alloc(26);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x0112, 10);
  tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(orientation, 18);
  tiff.writeUInt32LE(0, 22);
  const exifBody = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1Header = Buffer.alloc(4);
  app1Header.writeUInt16BE(0xff_e1, 0);
  app1Header.writeUInt16BE(exifBody.length + 2, 2);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from(jpeg.subarray(0, 2)),
      app1Header,
      exifBody,
      Buffer.from(jpeg.subarray(2)),
    ]),
  );
}

describe('clipboard image paste compression', () => {
  beforeEach(() => {
    readClipboardMedia.mockReset();
  });

  it('downsamples an oversized pasted image before storing it', async () => {
    const big = await solidPng(3600, 1800);
    readClipboardMedia.mockResolvedValue({ kind: 'image', bytes: big, mimeType: 'image/png' });

    const { store, pasteImage } = createPasteHarness();
    await pasteImage();

    expect(store.size()).toBe(1);
    const att = store.get(1);
    expect(att?.kind).toBe('image');
    if (att?.kind !== 'image') throw new Error('expected image attachment');

    expect(Math.max(att.width, att.height)).toBeLessThanOrEqual(2000);
    expect(att.placeholder).toContain('2000×1000');

    const dims = parseImageMeta(att.bytes);
    expect(dims).not.toBeNull();
    expect(Math.max(dims!.width, dims!.height)).toBeLessThanOrEqual(3000);
  });

  it('honors the harness [image] max_edge_px when pasting', async () => {
    const big = await solidPng(3600, 1800);
    readClipboardMedia.mockResolvedValue({ kind: 'image', bytes: big, mimeType: 'image/png' });

    const { store, pasteImage } = createPasteHarness({
      imageLimits: new ImageLimits(process.env, { maxEdgePx: 800 }),
    });
    await pasteImage();

    const att = store.get(1);
    if (att?.kind !== 'image') throw new Error('expected image attachment');
    expect(Math.max(att.width, att.height)).toBe(800);
    expect(att.placeholder).toContain('800×400');
    const dims = parseImageMeta(att.bytes);
    expect(dims).not.toBeNull();
    expect(Math.max(dims!.width, dims!.height)).toBe(800);
  });

  it('records the pre-compression original in memory for an oversized paste', async () => {
    const big = await solidPng(3600, 1800);
    readClipboardMedia.mockResolvedValue({ kind: 'image', bytes: big, mimeType: 'image/png' });

    const { store, pasteImage } = createPasteHarness();
    await pasteImage();

    const att = store.get(1);
    if (att?.kind !== 'image') throw new Error('expected image attachment');
    expect(att.original).toBeDefined();
    expect(att.original?.bytes).toEqual(big);
    expect(att.original?.width).toBe(3600);
    expect(att.original?.height).toBe(1800);
    expect(att.original?.byteLength).toBe(big.length);
    expect(att.original?.mime).toBe('image/png');

    expect(att.original?.path).toBeUndefined();
  });

  it('does not persist the original at paste time, even with a known session', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-paste-session-'));
    const big = await solidPng(3600, 1800);
    readClipboardMedia.mockResolvedValue({ kind: 'image', bytes: big, mimeType: 'image/png' });

    const { store, pasteImage } = createPasteHarness({ sessionDir });
    await pasteImage();

    const att = store.get(1);
    if (att?.kind !== 'image') throw new Error('expected image attachment');
    expect(att.original?.bytes).toEqual(big);
    expect(att.original?.path).toBeUndefined();
    expect(existsSync(join(sessionDir, 'media-originals'))).toBe(false);
    await rm(sessionDir, { recursive: true, force: true });
  });

  it('stores a within-budget paste byte-for-byte', async () => {
    const small = await solidPng(80, 80);
    readClipboardMedia.mockResolvedValue({ kind: 'image', bytes: small, mimeType: 'image/png' });

    const { store, pasteImage } = createPasteHarness();
    await pasteImage();

    const att = store.get(1);
    if (att?.kind !== 'image') throw new Error('expected image attachment');
    expect(att.width).toBe(80);
    expect(att.height).toBe(80);
    expect(att.bytes).toBe(small);
    expect(att.original).toBeUndefined();
  });

  it(
    'records an EXIF-rotated compressed original in display space',
    async () => {
      const portrait = withExifOrientation(await solidJpeg(3600, 400), 6);
      readClipboardMedia.mockResolvedValue({
        kind: 'image',
        bytes: portrait,
        mimeType: 'image/jpeg',
      });

      const { store, pasteImage } = createPasteHarness();
      await pasteImage();

      const att = store.get(1);
      if (att?.kind !== 'image') throw new Error('expected image attachment');
      expect(att.original?.width).toBe(400);
      expect(att.original?.height).toBe(3600);
      expect(att.width).toBeLessThan(att.height);
    },
    15_000,
  );

  it('stores display-space dimensions for an EXIF-rotated untouched paste', async () => {
    const portrait = withExifOrientation(await solidJpeg(120, 80), 6);
    readClipboardMedia.mockResolvedValue({
      kind: 'image',
      bytes: portrait,
      mimeType: 'image/jpeg',
    });

    const { store, pasteImage } = createPasteHarness();
    await pasteImage();

    const att = store.get(1);
    if (att?.kind !== 'image') throw new Error('expected image attachment');
    expect(att.bytes).toBe(portrait);
    expect(att.original).toBeUndefined();
    expect(att.width).toBe(80);
    expect(att.height).toBe(120);
    expect(att.placeholder).toContain('80×120');
  });

  it('emits image_compress telemetry tagged tui_paste through host.track', async () => {
    const big = await solidPng(3600, 1800);
    readClipboardMedia.mockResolvedValue({ kind: 'image', bytes: big, mimeType: 'image/png' });

    const { track, pasteImage } = createPasteHarness();
    await pasteImage();

    const compressCalls = track.mock.calls.filter(([event]) => event === 'image_compress');
    expect(compressCalls).toHaveLength(1);
    const props = compressCalls[0]![1] as Record<string, unknown>;
    expect(props['source']).toBe('tui_paste');
    expect(props['outcome']).toBe('compressed');
  });

  it('uploads final bytes with a crash-recovery TTL while the staging lease owns normal cleanup', async () => {
    const small = await solidPng(80, 80);
    readClipboardMedia.mockResolvedValue({ kind: 'image', bytes: small, mimeType: 'image/png' });
    const uploadFile = uploadFileMock('file-1');

    const { store, pasteImage } = createPasteHarness({ uploadFile });
    await pasteImage();

    const att = store.get(1);
    if (att?.kind !== 'image') throw new Error('expected image attachment');
    expect(att.fileId).toBe('file-1');
    expect(att.fileExpiresAt).toBe(Date.parse('2030-01-02T03:04:05.000Z'));
    expect(uploadFile).toHaveBeenCalledTimes(1);
    const [data, opts] = uploadFile.mock.calls[0]!;
    expect(new Uint8Array(data)).toEqual(small);
    expect(opts).toEqual({
      name: 'pasted-image.png',
      mimeType: 'image/png',
      expiresInSec: 60 * 60,
    });
    expect(att.bytes).toBe(small);
  });

  it('uploads the compressed bytes when paste-time compression changed them (v2)', async () => {
    const big = await solidPng(3600, 1800);
    readClipboardMedia.mockResolvedValue({ kind: 'image', bytes: big, mimeType: 'image/png' });
    const uploadFile = uploadFileMock('file-9');

    const { store, pasteImage } = createPasteHarness({ uploadFile });
    await pasteImage();

    const att = store.get(1);
    if (att?.kind !== 'image') throw new Error('expected image attachment');
    expect(att.fileId).toBe('file-9');
    const [data] = uploadFile.mock.calls[0]!;
    expect(data).toBe(att.bytes);
    expect(att.bytes).not.toBe(big);
  });

  it('keeps the paste on the inline fallback when the daemon upload fails (v2)', async () => {
    const small = await solidPng(80, 80);
    readClipboardMedia.mockResolvedValue({ kind: 'image', bytes: small, mimeType: 'image/png' });
    const uploadFile = vi.fn(
      async (
        _data: Uint8Array,
        _opts: { name: string; mimeType?: string; expiresInSec?: number },
      ): Promise<{ id: string }> => {
        throw new Error('daemon down');
      },
    );

    const { store, pasteImage } = createPasteHarness({ uploadFile });
    await pasteImage();

    const att = store.get(1);
    if (att?.kind !== 'image') throw new Error('expected image attachment');
    expect(att.fileId).toBeUndefined();
    expect(att.bytes).toBe(small);
  });

  it('settles the paste callback before the background daemon upload completes (v2)', async () => {
    const small = await solidPng(80, 80);
    readClipboardMedia.mockResolvedValue({ kind: 'image', bytes: small, mimeType: 'image/png' });
    let resolveUpload!: (meta: { id: string }) => void;
    const uploadFile = vi.fn(
      (
        _data: Uint8Array,
        _opts: { name: string; mimeType?: string; expiresInSec?: number },
      ): Promise<{ id: string }> =>
        new Promise<{ id: string }>((resolve) => {
          resolveUpload = resolve;
        }),
    );

    const { store, pasteImageRaw } = createPasteHarness({ uploadFile });
    await pasteImageRaw();

    const att = store.get(1);
    if (att?.kind !== 'image') throw new Error('expected image attachment');
    expect(att.placeholder).toBe('[image #1 (80×80)]');
    expect(att.fileId).toBeUndefined();
    expect(att.pending).toBeDefined();

    resolveUpload({ id: 'file-late' });
    await att.pending;

    expect(att.fileId).toBe('file-late');
    expect(att.pending).toBeUndefined();
  });
});

describe('clipboard video paste upload', () => {
  beforeEach(() => {
    readClipboardMedia.mockReset();
  });

  async function withSourceVideo(run: (sourcePath: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'paste-video-'));
    try {
      const sourcePath = join(dir, 'clip.mp4');
      await writeFile(sourcePath, 'video-bytes');
      await run(sourcePath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('uploads the pasted video to the daemon file store (v2)', async () => {
    await withSourceVideo(async (sourcePath) => {
      readClipboardMedia.mockResolvedValue({
        kind: 'video',
        mimeType: 'video/mp4',
        filename: 'clip.mp4',
        sourcePath,
      });
      const uploadFile = uploadFileMock('file-v1');

      const { store, pasteImage } = createPasteHarness({ uploadFile });
      await pasteImage();

      const att = store.get(1);
      if (att?.kind !== 'video') throw new Error('expected video attachment');
      expect(att.placeholder).toBe('[video #1 clip.mp4]');
      expect(att.fileId).toBe('file-v1');
      expect(att.fileExpiresAt).toBe(Date.parse('2030-01-02T03:04:05.000Z'));
      expect(att.pending).toBeUndefined();
      const [data, opts] = uploadFile.mock.calls[0]!;
      expect(new Uint8Array(data)).toEqual(new TextEncoder().encode('video-bytes'));
      expect(opts).toEqual({ name: 'clip.mp4', mimeType: 'video/mp4', expiresInSec: 60 * 60 });
    });
  });

  it('settles the paste callback before the background upload completes (v2)', async () => {
    await withSourceVideo(async (sourcePath) => {
      readClipboardMedia.mockResolvedValue({
        kind: 'video',
        mimeType: 'video/mp4',
        filename: 'clip.mp4',
        sourcePath,
      });
      let resolveUpload!: (meta: { id: string }) => void;
      const uploadFile = vi.fn(
        (
          _data: Uint8Array,
          _opts: { name: string; mimeType?: string; expiresInSec?: number },
        ): Promise<{ id: string }> =>
          new Promise<{ id: string }>((resolve) => {
            resolveUpload = resolve;
          }),
      );

      const { store, pasteImageRaw } = createPasteHarness({ uploadFile });
      await pasteImageRaw();

      const att = store.get(1);
      if (att?.kind !== 'video') throw new Error('expected video attachment');
      expect(att.fileId).toBeUndefined();
      expect(att.pending).toBeDefined();

      await vi.waitFor(() => {
        expect(uploadFile).toHaveBeenCalled();
      });
      resolveUpload({ id: 'file-vlate' });
      await att.pending;

      expect(att.fileId).toBe('file-vlate');
      expect(att.pending).toBeUndefined();
    });
  });

  it('leaves the video without a fileId when the daemon upload fails (v2)', async () => {
    await withSourceVideo(async (sourcePath) => {
      readClipboardMedia.mockResolvedValue({
        kind: 'video',
        mimeType: 'video/mp4',
        filename: 'clip.mp4',
        sourcePath,
      });
      const uploadFile = vi.fn(async (): Promise<{ id: string }> => {
        throw new Error('daemon down');
      });

      const { store, pasteImage } = createPasteHarness({ uploadFile });
      await pasteImage();

      const att = store.get(1);
      if (att?.kind !== 'video') throw new Error('expected video attachment');
      expect(att.fileId).toBeUndefined();
      expect(att.pending).toBeUndefined();
    });
  });

  it('leaves the video without a fileId when the source file vanished (v2)', async () => {
    readClipboardMedia.mockResolvedValue({
      kind: 'video',
      mimeType: 'video/mp4',
      filename: 'clip.mp4',
      sourcePath: '/tmp/kimi-paste-vanished-source.mp4',
    });
    const uploadFile = uploadFileMock('file-v1');

    const { store, pasteImage } = createPasteHarness({ uploadFile });
    await pasteImage();

    expect(uploadFile).not.toHaveBeenCalled();
    const att = store.get(1);
    if (att?.kind !== 'video') throw new Error('expected video attachment');
    expect(att.fileId).toBeUndefined();
  });
});
