/**
 * Clipboard image paste → attachment store, with ingestion-time compression.
 *
 * Tests pin:
 *   - an oversized pasted image is downsampled while building the attachment,
 *     so the stored bytes, the `[image #N (W×H)]` placeholder, and the eventual
 *     submitted image all agree on the compressed size
 *   - a within-budget paste is stored byte-for-byte (fast path)
 */

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
  pasteImage(): Promise<void>;
}

function createPasteHarness(): PasteHarness {
  const editor: Record<string, ((...args: never[]) => unknown) | undefined> = {};
  const store = new ImageAttachmentStore();
  const host = {
    state: {
      editor,
      activeDialog: null,
      appState: { streamingPhase: 'idle', isCompacting: false },
      footer: { setTransientHint: vi.fn() },
      ui: { requestRender: vi.fn() },
    },
    session: undefined,
    btwPanelController: { closeOrCancel: vi.fn(() => false) },
    track: vi.fn(),
    showError: vi.fn(),
    openUndoSelector: vi.fn(),
    cancelRunningShellCommand: vi.fn(),
  } as unknown as EditorKeyboardHost;

  const controller = new EditorKeyboardController(host, store);
  controller.install();

  return {
    store,
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

describe('clipboard image paste compression', () => {
  beforeEach(() => {
    readClipboardMedia.mockReset();
  });

  it('downsamples an oversized pasted image before storing it', async () => {
    const big = await solidPng(2600, 2600);
    readClipboardMedia.mockResolvedValue({ kind: 'image', bytes: big, mimeType: 'image/png' });

    const { store, pasteImage } = createPasteHarness();
    await pasteImage();

    expect(store.size()).toBe(1);
    const att = store.get(1);
    expect(att?.kind).toBe('image');
    if (att?.kind !== 'image') throw new Error('expected image attachment');

    // Stored metadata reflects the compressed size.
    expect(Math.max(att.width, att.height)).toBeLessThanOrEqual(2000);
    expect(att.placeholder).toContain('2000×2000');

    // The stored bytes decode to the compressed dimensions — the thumbnail and
    // the submitted image both read from these bytes, so they cannot diverge.
    const dims = parseImageMeta(att.bytes);
    expect(dims).not.toBeNull();
    expect(Math.max(dims!.width, dims!.height)).toBeLessThanOrEqual(2000);
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
  });
});
