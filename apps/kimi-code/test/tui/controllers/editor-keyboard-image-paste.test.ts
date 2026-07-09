/**
 * Clipboard image paste → attachment store, with ingestion-time compression.
 *
 * Tests pin:
 *   - an oversized pasted image is downsampled while building the attachment,
 *     so the stored bytes, the `[image #N (W×H)]` placeholder, and the eventual
 *     submitted image all agree on the compressed size
 *   - the pre-compression original is persisted and recorded on the
 *     attachment, so the submitted prompt can announce the compression and
 *     point the model at the full-fidelity bytes
 *   - a within-budget paste is stored byte-for-byte (fast path), with no
 *     original recorded
 */

import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
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

// vitest hoists vi.mock/vi.hoisted above the imports above, so the mock still
// applies to the editor-keyboard module that pulls in readClipboardMedia.
const { readClipboardMedia } = vi.hoisted(() => ({ readClipboardMedia: vi.fn() }));

vi.mock('#/utils/clipboard/clipboard-image', async (importActual) => {
  const actual = await importActual<typeof import('#/utils/clipboard/clipboard-image')>();
  return { ...actual, readClipboardMedia };
});

interface PasteHarness {
  readonly store: ImageAttachmentStore;
  readonly track: ReturnType<typeof vi.fn>;
  pasteImage(): Promise<void>;
}

function createPasteHarness(options: { sessionDir?: string } = {}): PasteHarness {
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

  const controller = new EditorKeyboardController(host, store);
  controller.install();

  return {
    store,
    track,
    async pasteImage() {
      const handler = editor['onPasteImage'];
      if (handler === undefined) throw new Error('onPasteImage handler not installed');
      await (handler as () => Promise<boolean>)();
    },
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

/**
 * Insert a minimal EXIF APP1 segment carrying only an Orientation tag right
 * after the JPEG SOI marker (jimp itself never writes EXIF). Mirrors the
 * fixture in agent-core's image-compress tests.
 */
function withExifOrientation(jpeg: Uint8Array, orientation: number): Uint8Array {
  // TIFF body, little-endian: 8-byte header + IFD0 with a single entry.
  const tiff = Buffer.alloc(26);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4); // offset of IFD0
  tiff.writeUInt16LE(1, 8); // one directory entry
  tiff.writeUInt16LE(0x0112, 10); // tag: Orientation
  tiff.writeUInt16LE(3, 12); // type: SHORT
  tiff.writeUInt32LE(1, 14); // count
  tiff.writeUInt16LE(orientation, 18); // value, left-aligned in the 4-byte field
  tiff.writeUInt32LE(0, 22); // no next IFD
  const exifBody = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1Header = Buffer.alloc(4);
  app1Header.writeUInt16BE(0xff_e1, 0);
  app1Header.writeUInt16BE(exifBody.length + 2, 2);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from(jpeg.subarray(0, 2)), // SOI
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

    // Stored metadata reflects the compressed size.
    expect(Math.max(att.width, att.height)).toBeLessThanOrEqual(2000);
    expect(att.placeholder).toContain('2000×1000');

    // The stored bytes decode to the compressed dimensions — the thumbnail and
    // the submitted image both read from these bytes, so they cannot diverge.
    const dims = parseImageMeta(att.bytes);
    expect(dims).not.toBeNull();
    expect(Math.max(dims!.width, dims!.height)).toBeLessThanOrEqual(2000);
  });

  it('records and persists the pre-compression original for an oversized paste', async () => {
    const big = await solidPng(3600, 1800);
    readClipboardMedia.mockResolvedValue({ kind: 'image', bytes: big, mimeType: 'image/png' });

    const { store, pasteImage } = createPasteHarness();
    await pasteImage();

    const att = store.get(1);
    if (att?.kind !== 'image') throw new Error('expected image attachment');
    expect(att.original).toBeDefined();
    expect(att.original?.width).toBe(3600);
    expect(att.original?.height).toBe(1800);
    expect(att.original?.byteLength).toBe(big.length);
    expect(att.original?.mime).toBe('image/png');

    // The original bytes are readable back from the persisted path.
    expect(att.original?.path).not.toBeNull();
    const persisted = await readFile(att.original!.path!);
    expect(new Uint8Array(persisted)).toEqual(big);
    await unlink(att.original!.path!).catch(() => undefined);
  });

  it('persists the original into the session media-originals dir when the session is known', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-paste-session-'));
    const big = await solidPng(3600, 1800);
    readClipboardMedia.mockResolvedValue({ kind: 'image', bytes: big, mimeType: 'image/png' });

    const { store, pasteImage } = createPasteHarness({ sessionDir });
    await pasteImage();

    const att = store.get(1);
    if (att?.kind !== 'image') throw new Error('expected image attachment');
    expect(att.original?.path).not.toBeNull();
    expect(att.original!.path!.startsWith(join(sessionDir, 'media-originals'))).toBe(true);
    const persisted = await readFile(att.original!.path!);
    expect(new Uint8Array(persisted)).toEqual(big);
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
    expect(att.bytes).toBe(small); // identity: no re-encode on the fast path
    expect(att.original).toBeUndefined();
  });

  it(
    'records an EXIF-rotated compressed original in display space',
    async () => {
      // Orientation 6 (rotate 90° CW): the header says 3600x400, but the image
      // decodes to 400x3600 — the space the compressed bytes and any later
      // ReadMediaFile region readback live in. The recorded original (which
      // drives the submit-time compression caption) must match that space, or
      // the caption contradicts the sent image's aspect and region coordinates
      // land axis-swapped. (Kept narrow: pure-JS decode+rotate+encode of a
      // larger frame can outlast the test timeout on slow CI runners.)
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
      // The compressed attachment itself keeps the portrait aspect.
      expect(att.width).toBeLessThan(att.height);
      await unlink(att.original!.path!).catch(() => undefined);
    },
    15_000,
  );

  it('stores display-space dimensions for an EXIF-rotated untouched paste', async () => {
    // Within budgets → sent byte-for-byte, but the placeholder and metadata
    // must still describe the display (rotated) space.
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
    expect(att.bytes).toBe(portrait); // fast path — untouched
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
});
