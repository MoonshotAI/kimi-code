// apps/kimi-web/test/media-preview-size.test.ts
// The media preview header shows `size` — for user-uploaded media the
// ToolMedia carries no bytes, so openMediaPreview must recover the size from
// the data: URL (rehydrated uploads) or from the fetched blob (file-store
// media), instead of falling back to a misleading "0 B".
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useFilePreview } from '../src/composables/useFilePreview';
import type { ToolMedia } from '../src/types';

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const getFileBlob = vi.fn();
vi.mock('../src/api', () => ({ getKimiWebApi: () => ({ getFileBlob }) }));

function setup() {
  return useFilePreview({
    client: {} as never,
    detailTarget: ref(null),
  });
}

function dataUrl(bytes: number): string {
  return `data:image/png;base64,${Buffer.alloc(bytes).toString('base64')}`;
}

describe('openMediaPreview size', () => {
  beforeEach(() => {
    getFileBlob.mockReset();
    (globalThis.URL as unknown as { createObjectURL: unknown }).createObjectURL = vi
      .fn()
      .mockReturnValue('blob:mock-url');
    (globalThis.URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
  });

  it('recovers the size from a data: URL when media.bytes is missing', () => {
    const { previewFile, openMediaPreview } = setup();
    const media: ToolMedia = { kind: 'image', url: dataUrl(1024) };
    openMediaPreview(media);
    expect(previewFile.value?.size).toBe(1024);
    expect(previewFile.value?.mime).toBe('image/png');
  });

  it('handles data: URLs with mediatype parameters (RFC 2397)', () => {
    const { previewFile, openMediaPreview } = setup();
    const b64 = Buffer.alloc(1024).toString('base64');
    const media: ToolMedia = { kind: 'image', url: `data:image/svg+xml;charset=utf-8;base64,${b64}` };
    openMediaPreview(media);
    expect(previewFile.value?.size).toBe(1024);
    expect(previewFile.value?.mime).toBe('image/svg+xml');
  });

  it('prefers explicit media.bytes over the data: URL estimate', () => {
    const { previewFile, openMediaPreview } = setup();
    const media: ToolMedia = { kind: 'image', url: dataUrl(1024), bytes: 42 };
    openMediaPreview(media);
    expect(previewFile.value?.size).toBe(42);
  });

  it('fills the size from the fetched blob for file-store media', async () => {
    getFileBlob.mockResolvedValue(new Blob([Buffer.alloc(500)]));
    const { previewFile, openMediaPreview } = setup();
    const media: ToolMedia = { kind: 'image', url: 'https://daemon/files/f_1', fileId: 'f_1' };
    openMediaPreview(media);
    expect(previewFile.value?.size).toBe(0); // unknown until the blob lands
    await vi.waitFor(() => expect(previewFile.value?.size).toBe(500));
    expect(previewFile.value?.sourceUrl).toBe('blob:mock-url');
  });

  it('keeps a known media.bytes instead of overwriting it with the blob size', async () => {
    getFileBlob.mockResolvedValue(new Blob([Buffer.alloc(500)]));
    const { previewFile, openMediaPreview } = setup();
    const media: ToolMedia = { kind: 'image', url: 'https://daemon/files/f_1', fileId: 'f_1', bytes: 42 };
    openMediaPreview(media);
    await vi.waitFor(() => expect(previewFile.value?.sourceUrl).toBe('blob:mock-url'));
    expect(previewFile.value?.size).toBe(42);
  });

  it('falls back to a generic localized label when the media has no path', () => {
    const { previewFile, openMediaPreview } = setup();
    openMediaPreview({ kind: 'image', url: dataUrl(1) });
    expect(previewFile.value?.path).toBe('composer.attachmentImage');
    openMediaPreview({ kind: 'video', url: dataUrl(1) });
    expect(previewFile.value?.path).toBe('composer.attachmentVideo');
  });
});
