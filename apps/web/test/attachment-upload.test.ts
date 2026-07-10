import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useAttachmentUpload, type Attachment } from '../src/composables/useAttachmentUpload';

// The composable registers its paste listener and cleanup via onMounted /
// onUnmounted. Outside a component (unit test) there is no active instance, so
// Vue would warn; stub the two hooks since these tests don't exercise the
// lifecycle itself.
vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue')>();
  return { ...actual, onMounted: vi.fn(), onUnmounted: vi.fn() };
});

type UploadImage = (
  file: Blob,
  name?: string,
) => Promise<{ fileId: string; name: string; mediaType: string } | null>;

function setup(uploadImage?: UploadImage, sessionId: string | null = 'test-session') {
  return useAttachmentUpload({ uploadImage: () => uploadImage, sessionId: () => sessionId ?? undefined });
}

function imageFile(name: string): File {
  return { name, type: 'image/png' } as unknown as File;
}

function inputEvent(files: File[]): Event {
  return { target: { files, value: 'x' } } as unknown as Event;
}

describe('useAttachmentUpload', () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
    revokeObjectURL = vi.fn();
    (globalThis.URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL;
    (globalThis.URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeObjectURL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('adds an uploading attachment via the file input', () => {
    const uploadImage = vi.fn<UploadImage>().mockResolvedValue({ fileId: 'f1', name: 'a.png', mediaType: 'image/png' });
    const att = setup(uploadImage);
    att.handleFileInputChange(inputEvent([imageFile('a.png')]));

    expect(att.attachments.value).toHaveLength(1);
    expect(att.attachments.value[0]).toMatchObject({ name: 'a.png', kind: 'image', uploading: true });
    expect(createObjectURL).toHaveBeenCalledOnce();
  });

  it('ignores non-media files', () => {
    const uploadImage = vi.fn<UploadImage>().mockResolvedValue(null);
    const att = setup(uploadImage);
    att.handleFileInputChange(inputEvent([{ name: 'a.txt', type: 'text/plain' } as unknown as File]));
    expect(att.attachments.value).toHaveLength(0);
  });

  it('is a no-op when uploadImage is not provided', () => {
    const att = setup(undefined);
    att.handleFileInputChange(inputEvent([imageFile('a.png')]));
    expect(att.attachments.value).toHaveLength(0);
  });

  it('removeAttachment drops the entry and revokes its object URL', () => {
    const uploadImage = vi.fn<UploadImage>().mockResolvedValue(null);
    const att = setup(uploadImage);
    att.handleFileInputChange(inputEvent([imageFile('a.png')]));
    const localId = att.attachments.value[0].localId;

    att.removeAttachment(localId);
    expect(att.attachments.value).toHaveLength(0);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });

  it('removeAttachment also closes the preview when it shows the removed entry', () => {
    const uploadImage = vi.fn<UploadImage>().mockResolvedValue(null);
    const att = setup(uploadImage);
    att.handleFileInputChange(inputEvent([imageFile('a.png')]));
    const added = att.attachments.value[0];
    att.openAttachmentPreview(added);
    expect(att.previewAttachment.value).not.toBeNull();

    att.removeAttachment(added.localId);
    expect(att.previewAttachment.value).toBeNull();
  });

  it('openAttachmentPreview / closeAttachmentPreview toggle the preview', () => {
    const att = setup(undefined);
    const item: Attachment = { localId: 'x', name: 'a.png', kind: 'image', previewUrl: 'blob:x', uploading: false };
    att.openAttachmentPreview(item);
    expect(att.previewAttachment.value?.localId).toBe('x');
    att.closeAttachmentPreview();
    expect(att.previewAttachment.value).toBeNull();
  });

  it('clearAfterSubmit revokes every object URL and empties the list', () => {
    const uploadImage = vi.fn<UploadImage>().mockResolvedValue(null);
    const att = setup(uploadImage);
    att.handleFileInputChange(inputEvent([imageFile('a.png'), imageFile('b.png')]));
    expect(att.attachments.value).toHaveLength(2);

    att.clearAfterSubmit();
    expect(att.attachments.value).toHaveLength(0);
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it('loadAttachments refills an already-uploaded attachment without re-uploading', () => {
    const att = setup(undefined);
    att.loadAttachments([
      { fileId: 'f_existing', kind: 'image', url: 'data:image/png;base64,AAAA', name: 'a.png' },
    ]);
    expect(att.attachments.value).toHaveLength(1);
    expect(att.attachments.value[0]).toMatchObject({
      fileId: 'f_existing',
      kind: 'image',
      name: 'a.png',
      uploading: false,
      previewUrl: 'data:image/png;base64,AAAA',
    });
  });

  it('loadAttachments replaces any unsent draft attachments instead of appending', () => {
    const uploadImage = vi.fn<UploadImage>().mockResolvedValue(null);
    const att = setup(uploadImage);
    att.handleFileInputChange(inputEvent([imageFile('draft.png')]));
    expect(att.attachments.value).toHaveLength(1);

    att.loadAttachments([
      { fileId: 'f_existing', kind: 'image', url: 'data:image/png;base64,AAAA', name: 'refill.png' },
    ]);
    expect(att.attachments.value).toHaveLength(1);
    expect(att.attachments.value[0].name).toBe('refill.png');
  });

  it('loadAttachments with an empty list clears the attachment strip', () => {
    const uploadImage = vi.fn<UploadImage>().mockResolvedValue(null);
    const att = setup(uploadImage);
    att.handleFileInputChange(inputEvent([imageFile('draft.png')]));
    expect(att.attachments.value).toHaveLength(1);

    att.loadAttachments([]);
    expect(att.attachments.value).toHaveLength(0);
  });

  it('loadAttachments re-uploads a fileId-less data URL so it becomes resendable', async () => {
    const uploadImage = vi.fn<UploadImage>().mockResolvedValue({ fileId: 'f_new', name: 'a.png', mediaType: 'image/png' });
    const att = setup(uploadImage);
    const blob = new Blob(['x'], { type: 'image/png' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve(blob) }));

    att.loadAttachments([{ kind: 'image', url: 'data:image/png;base64,AAAA', name: 'a.png' }]);
    expect(att.attachments.value).toHaveLength(1);
    expect(att.attachments.value[0].uploading).toBe(true);

    // Flush the fetch → blob → upload promise chain so the re-upload resolves.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(att.attachments.value[0].uploading).toBe(false);
    expect(att.attachments.value[0].fileId).toBe('f_new');
    expect(uploadImage).toHaveBeenCalledOnce();
  });

  it('loadAttachments skips a fileId-less data URL when re-upload is unavailable', () => {
    const att = setup(undefined);
    att.loadAttachments([{ kind: 'image', url: 'data:image/png;base64,AAAA', name: 'a.png' }]);
    expect(att.attachments.value).toHaveLength(0);
  });

  it('loadAttachments re-uploads a fileId-less http URL so it becomes resendable', async () => {
    const uploadImage = vi.fn<UploadImage>().mockResolvedValue({ fileId: 'f_http', name: 'x.png', mediaType: 'image/png' });
    const att = setup(uploadImage);
    const blob = new Blob(['x'], { type: 'image/png' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve(blob) }));

    att.loadAttachments([{ kind: 'image', url: 'https://example.test/x.png', name: 'x.png' }]);
    expect(att.attachments.value).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(att.attachments.value[0].fileId).toBe('f_http');
  });

  it('loadAttachments drops a fileId-less URL whose fetch fails', async () => {
    const uploadImage = vi.fn<UploadImage>().mockResolvedValue({ fileId: 'f_x', name: 'x.png', mediaType: 'image/png' });
    const att = setup(uploadImage);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));

    att.loadAttachments([{ kind: 'image', url: 'https://example.test/protected.png', name: 'protected.png' }]);
    expect(att.attachments.value).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(att.attachments.value).toHaveLength(0);
  });

  it('isolates attachments between sessions', () => {
    const uploadImage = vi.fn<UploadImage>().mockResolvedValue(null);
    const sessionId = ref<string | undefined>('sess-a');
    const att = useAttachmentUpload({ uploadImage: () => uploadImage, sessionId: () => sessionId.value });

    att.handleFileInputChange(inputEvent([imageFile('a.png')]));
    expect(att.attachments.value).toHaveLength(1);

    // Switch to session B — A's attachment must not show up here.
    sessionId.value = 'sess-b';
    expect(att.attachments.value).toHaveLength(0);
    att.handleFileInputChange(inputEvent([imageFile('b.png')]));
    expect(att.attachments.value).toHaveLength(1);

    // Switch back to A — its attachment is still there.
    sessionId.value = 'sess-a';
    expect(att.attachments.value).toHaveLength(1);
    expect(att.attachments.value[0].name).toBe('a.png');

    // B's attachment is gone from A's view.
    expect(att.attachments.value.map((a) => a.name)).not.toContain('b.png');
  });
});
