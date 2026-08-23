// packages/app-client/test/attachment-upload-pill-seam.test.ts
// The desktop attachment-pill seam (insertFileAttachment): non-media files
// are offered to the composer's in-document pills BEFORE the chip path;
// media and seam-declined files keep the old chip/upload behavior, and
// without the seam (web) nothing changes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { useAttachmentUpload } from '../src/composables/useAttachmentUpload';
import { noopProductTracker, setProductTracker } from '../src/contracts';

// The composable registers its paste listener and cleanup via onMounted /
// onUnmounted; outside a component there is no active instance — run the
// mount callback immediately (so the document listeners register against
// our stubbed document) and capture them for direct dispatch.
const docListeners = new Map<string, (e: Event) => void>();
vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue')>();
  return { ...actual, onMounted: vi.fn((cb: () => void) => cb()), onUnmounted: vi.fn() };
});
(globalThis as { document?: unknown }).document = {
  addEventListener: (type: string, fn: (e: Event) => void) => docListeners.set(type, fn),
  removeEventListener: (type: string) => docListeners.delete(type),
};

/** Dispatch a paste through the composable's document-level listener. */
function paste(files: File[]): void {
  docListeners.get('paste')?.(pasteEvent(files) as unknown as Event);
}

const apiMock = {
  getFileBlob: vi.fn(async () => new Blob(['x'], { type: 'image/png' })),
  getSessionMediaBlob: vi.fn(async () => new Blob(['x'], { type: 'image/png' })),
  getFileUrl: (id: string) => `/files/${id}`,
  getSessionMediaUrl: (sid: string, id: string) => `/sessions/${sid}/media/${id}`,
};

/** In-memory localStorage for the draft-persistence paths. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => {
      map.clear();
    },
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

type UploadImage = (
  file: Blob,
  name?: string,
) => Promise<{ fileId: string; name: string; mediaType: string } | null>;

type InsertFileAttachment = NonNullable<
  Parameters<typeof useAttachmentUpload>[0]['insertFileAttachment']
>;
type AdoptFileAttachment = NonNullable<
  Parameters<typeof useAttachmentUpload>[0]['adoptFileAttachment']
>;

function setup(options?: {
  uploadImage?: UploadImage;
  insertFileAttachment?: InsertFileAttachment;
  adoptFileAttachment?: AdoptFileAttachment;
}) {
  return useAttachmentUpload({
    api: apiMock,
    uploadImage: () => options?.uploadImage,
    sessionId: () => 'sess_1',
    insertFileAttachment: options?.insertFileAttachment,
    adoptFileAttachment: options?.adoptFileAttachment,
  });
}

const uploadOk: UploadImage = async (file, name) => ({
  fileId: 'f1',
  name: name ?? 'n',
  mediaType: (file as File).type || 'application/octet-stream',
});

function pdfFile(name = 'a.pdf'): File {
  return new File(['x'], name, { type: 'application/pdf' });
}

function inputEvent(files: File[]): Event {
  return { target: { files, value: 'x' } } as unknown as Event;
}

function dropEvent(files: File[], coords?: { clientX: number; clientY: number }): DragEvent {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    dataTransfer: { files },
    clientX: coords?.clientX ?? 0,
    clientY: coords?.clientY ?? 0,
  } as unknown as DragEvent;
}

function pasteEvent(files: File[]): ClipboardEvent {
  return {
    preventDefault: vi.fn(),
    clipboardData: {
      items: files.map((file) => ({
        kind: 'file',
        type: file.type,
        getAsFile: () => file,
        webkitGetAsEntry: () => null,
      })),
      files: [],
      getData: () => '',
    },
  } as unknown as ClipboardEvent;
}

/** Stub the desktop preload bridge: getPathForFile resolves '/abs/<name>'. */
function stubBridge(): void {
  (globalThis as { window?: unknown }).window = {
    kimiDesktop: { getPathForFile: (file: File) => `/abs/${file.name}` },
  };
}

function unstubBridge(): void {
  delete (globalThis as { window?: unknown }).window;
}

describe('insertFileAttachment seam', () => {
  let createObjectURL: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
    (globalThis.URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL;
    (globalThis.URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    unstubBridge();
    vi.restoreAllMocks();
  });

  it('routes a picked non-media file to the seam with its bridge-resolved path', () => {
    stubBridge();
    const insertFileAttachment = vi.fn<InsertFileAttachment>().mockReturnValue(true);
    const att = setup({ uploadImage: uploadOk, insertFileAttachment });

    att.handleFileInputChange(inputEvent([pdfFile()]));

    expect(insertFileAttachment).toHaveBeenCalledOnce();
    const [file, path, at] = insertFileAttachment.mock.calls[0]!;
    expect((file as File).name).toBe('a.pdf');
    expect(path).toBe('/abs/a.pdf');
    expect(at).toBeUndefined();
    // Handled as a pill — the chip strip stays empty.
    expect(att.attachments.value).toHaveLength(0);
  });

  it('passes null as the path when the bridge cannot resolve it (pasted bytes)', () => {
    // No window stub → no bridge → null path.
    const insertFileAttachment = vi.fn<InsertFileAttachment>().mockReturnValue(true);
    const att = setup({ uploadImage: uploadOk, insertFileAttachment });

    att.handleFileInputChange(inputEvent([pdfFile()]));

    expect(insertFileAttachment).toHaveBeenCalledOnce();
    expect(insertFileAttachment.mock.calls[0]![1]).toBeNull();
    expect(att.attachments.value).toHaveLength(0);
  });

  it('falls back to the chip path when the seam declines the file', () => {
    const insertFileAttachment = vi.fn<InsertFileAttachment>().mockReturnValue(false);
    const att = setup({ uploadImage: uploadOk, insertFileAttachment });

    att.handleFileInputChange(inputEvent([pdfFile()]));

    expect(insertFileAttachment).toHaveBeenCalledOnce();
    expect(att.attachments.value).toHaveLength(1);
    expect(att.attachments.value[0]).toMatchObject({ name: 'a.pdf', kind: 'file' });
  });

  it('never routes media files to the seam', () => {
    const insertFileAttachment = vi.fn<InsertFileAttachment>().mockReturnValue(true);
    const att = setup({ uploadImage: uploadOk, insertFileAttachment });

    att.handleFileInputChange(
      inputEvent([new File(['x'], 'shot.png', { type: 'image/png' })]),
    );

    expect(insertFileAttachment).not.toHaveBeenCalled();
    expect(att.attachments.value).toHaveLength(1);
    expect(att.attachments.value[0].kind).toBe('image');
  });

  it('keeps the chip path untouched when no seam is injected (web)', () => {
    const att = setup({ uploadImage: uploadOk });

    att.handleFileInputChange(inputEvent([pdfFile()]));

    expect(att.attachments.value).toHaveLength(1);
    expect(att.attachments.value[0].kind).toBe('file');
  });

  it('forwards drop coordinates so the pill can land at the drop point', () => {
    const insertFileAttachment = vi.fn<InsertFileAttachment>().mockReturnValue(true);
    const att = setup({ uploadImage: uploadOk, insertFileAttachment });

    att.handleDrop(dropEvent([pdfFile()], { clientX: 120, clientY: 48 }));

    expect(insertFileAttachment).toHaveBeenCalledOnce();
    expect(insertFileAttachment.mock.calls[0]![2]).toEqual({ clientX: 120, clientY: 48 });
    expect(att.attachments.value).toHaveLength(0);
  });

  it('anchors only the first file of a dropped batch at the drop point — later ones append in order', () => {
    // Each accepted insert already changed the document, so re-resolving the
    // same coordinates for the next file would land it BEFORE the pills just
    // inserted; the batch keeps the DataTransfer order by chaining at the
    // caret instead (same rule as dropped folders).
    const insertFileAttachment = vi.fn<InsertFileAttachment>().mockReturnValue(true);
    const att = setup({ uploadImage: uploadOk, insertFileAttachment });

    att.handleDrop(dropEvent([pdfFile('a.pdf'), pdfFile('b.pdf'), pdfFile('c.pdf')], { clientX: 120, clientY: 48 }));

    expect(insertFileAttachment).toHaveBeenCalledTimes(3);
    expect(insertFileAttachment.mock.calls.map((call) => [call[0].name, call[2]])).toEqual([
      ['a.pdf', { clientX: 120, clientY: 48 }],
      ['b.pdf', undefined],
      ['c.pdf', undefined],
    ]);
  });

  it('gives the coordinates to the first file the seam ACCEPTS (a declined first file passes them on)', () => {
    const insertFileAttachment = vi.fn<InsertFileAttachment>()
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    const att = setup({ uploadImage: uploadOk, insertFileAttachment });

    att.handleDrop(dropEvent([pdfFile('a.pdf'), pdfFile('b.pdf')], { clientX: 120, clientY: 48 }));

    expect(insertFileAttachment.mock.calls.map((call) => call[2])).toEqual([
      { clientX: 120, clientY: 48 },
      { clientX: 120, clientY: 48 },
    ]);
    // The declined file fell back to the chip path.
    expect(att.attachments.value).toHaveLength(1);
  });

  it('routes a pasted non-media file to the seam (no coordinates)', () => {
    const insertFileAttachment = vi.fn<InsertFileAttachment>().mockReturnValue(true);
    const att = setup({ uploadImage: uploadOk, insertFileAttachment });

    paste([pdfFile()]);

    expect(insertFileAttachment).toHaveBeenCalledOnce();
    expect(insertFileAttachment.mock.calls[0]![2]).toBeUndefined();
    expect(att.attachments.value).toHaveLength(0);
  });

  it('splits a mixed batch: media to the strip, files to the seam', () => {
    const insertFileAttachment = vi.fn<InsertFileAttachment>().mockReturnValue(true);
    const att = setup({ uploadImage: uploadOk, insertFileAttachment });

    att.handleFileInputChange(
      inputEvent([new File(['x'], 'shot.png', { type: 'image/png' }), pdfFile()]),
    );

    expect(insertFileAttachment).toHaveBeenCalledOnce();
    expect(att.attachments.value).toHaveLength(1);
    expect(att.attachments.value[0].kind).toBe('image');
  });

  it('stamps one batch in selection order across the seam and the chip path (image before pdf stays image-first)', () => {
    // The image's chip stamp is only assigned in the addFiles call AFTER the
    // loop — without batch pre-assignment the pdf's pill (stamped at the
    // seam, inside the loop) would always win and the payload would invert
    // the user's [image, pdf] selection order.
    const insertFileAttachment = vi.fn<InsertFileAttachment>().mockReturnValue(true);
    const att = setup({ uploadImage: uploadOk, insertFileAttachment });

    att.handleFileInputChange(
      inputEvent([new File(['x'], 'shot.png', { type: 'image/png' }), pdfFile('doc.pdf')]),
    );

    const pillSeq = insertFileAttachment.mock.calls[0]![3];
    const chipSeq = att.attachments.value[0]!.seq;
    expect(typeof pillSeq).toBe('number');
    expect(typeof chipSeq).toBe('number');
    expect(chipSeq!).toBeLessThan(pillSeq!);
  });

  it('stamps one batch in selection order across the seam and the chip path (pdf before image stays pdf-first)', () => {
    const insertFileAttachment = vi.fn<InsertFileAttachment>().mockReturnValue(true);
    const att = setup({ uploadImage: uploadOk, insertFileAttachment });

    att.handleFileInputChange(
      inputEvent([pdfFile('doc.pdf'), new File(['x'], 'shot.png', { type: 'image/png' })]),
    );

    const pillSeq = insertFileAttachment.mock.calls[0]![3];
    const chipSeq = att.attachments.value[0]!.seq;
    expect(pillSeq!).toBeLessThan(chipSeq!);
  });

  it('does not call the seam when attaching is disabled (no upload dep)', () => {
    const insertFileAttachment = vi.fn<InsertFileAttachment>().mockReturnValue(true);
    const att = setup({ insertFileAttachment });

    att.handleFileInputChange(inputEvent([pdfFile()]));
    att.handleDrop(dropEvent([pdfFile()]));
    paste([pdfFile()]);

    expect(insertFileAttachment).not.toHaveBeenCalled();
    expect(att.attachments.value).toHaveLength(0);
  });

  it('tracks a pill-routed file with the same attachment_added event', () => {
    const spy = vi.fn();
    setProductTracker({ track: spy });
    try {
      const insertFileAttachment = vi.fn<InsertFileAttachment>().mockReturnValue(true);
      const att = setup({ uploadImage: uploadOk, insertFileAttachment });

      att.handleDrop(dropEvent([pdfFile()]));

      expect(spy).toHaveBeenCalledOnce();
      expect(spy).toHaveBeenCalledWith('attachment_added', {
        via: 'drop',
        kind: 'file',
        size_bucket: '<1mb',
        count: 1,
      });
    } finally {
      setProductTracker(noopProductTracker);
    }
  });
});

describe('adoptFileAttachment rehydration seam', () => {
  let original: Storage | undefined;

  beforeEach(() => {
    original = (globalThis as { localStorage?: Storage }).localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      value: memoryStorage(),
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    if (original === undefined) {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    } else {
      Object.defineProperty(globalThis, 'localStorage', { value: original, configurable: true, writable: true });
    }
    vi.restoreAllMocks();
  });

  /** Seed the chip-draft key (#308 persistence) with ready entries. */
  function seedChipDraft(entries: Array<Record<string, unknown>>): void {
    localStorage.setItem('kimi-web.attachment-draft.sess_1', JSON.stringify(entries));
  }

  const fileDraft = { fileId: 'f_file', kind: 'file', name: 'legacy.pdf', mediaType: 'application/pdf', size: 24 };
  const imageDraft = { fileId: 'f_img', kind: 'image', name: 'shot.png', mediaType: 'image/png', size: 99 };

  it('adopts a persisted file draft as a pill (no chip), media rehydrates as a chip', async () => {
    seedChipDraft([fileDraft, imageDraft]);
    const adoptFileAttachment = vi.fn<AdoptFileAttachment>();
    const att = setup({ uploadImage: uploadOk, adoptFileAttachment });
    await new Promise((r) => setTimeout(r, 0));

    // The file went to the pill seam with its fileId reused; only the image
    // came back as a chip.
    expect(adoptFileAttachment).toHaveBeenCalledOnce();
    expect(adoptFileAttachment.mock.calls[0]![0]).toMatchObject({ kind: 'file', fileId: 'f_file', name: 'legacy.pdf' });
    expect(att.attachments.value).toHaveLength(1);
    expect(att.attachments.value[0]).toMatchObject({ kind: 'image', fileId: 'f_img' });
  });

  it('rewrites the persisted draft to media-only after adoption (no double-adopt next mount)', () => {
    seedChipDraft([fileDraft, imageDraft]);
    const adoptFileAttachment = vi.fn<AdoptFileAttachment>();
    setup({ uploadImage: uploadOk, adoptFileAttachment });

    const persisted = JSON.parse(localStorage.getItem('kimi-web.attachment-draft.sess_1') ?? '[]') as Array<{ kind: string }>;
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.kind).toBe('image');
  });

  it('removes the persisted key entirely when every draft was adopted', () => {
    seedChipDraft([fileDraft]);
    const adoptFileAttachment = vi.fn<AdoptFileAttachment>();
    setup({ uploadImage: uploadOk, adoptFileAttachment });

    expect(localStorage.getItem('kimi-web.attachment-draft.sess_1')).toBeNull();
  });

  it('rehydrates file drafts as chips when no adoption seam exists (web)', async () => {
    seedChipDraft([fileDraft]);
    const adoptFileAttachment = vi.fn<AdoptFileAttachment>();
    const att = setup({ uploadImage: uploadOk });
    await new Promise((r) => setTimeout(r, 0));

    expect(adoptFileAttachment).not.toHaveBeenCalled();
    expect(att.attachments.value).toHaveLength(1);
    expect(att.attachments.value[0]).toMatchObject({ kind: 'file', fileId: 'f_file' });
  });

  it('defers file adoption on a session switch until adoptStoredFileDrafts runs (media hydrates at once)', async () => {
    // Regression: the composable's session watcher fires before the
    // composer's own stash/restore watcher — while the editor still shows
    // the OLD session. The watcher must therefore DEFER the file drafts
    // (media hydrates immediately, it never touches the editor); adopting
    // there inserted the pills into the old session's document AND dropped
    // the stored draft, so the new session lost its files.
    seedChipDraft([fileDraft, imageDraft]);
    const sid = ref<string | undefined>('sess_0');
    const adoptFileAttachment = vi.fn<AdoptFileAttachment>();
    const att = useAttachmentUpload({
      api: apiMock,
      uploadImage: () => uploadOk,
      sessionId: () => sid.value,
      adoptFileAttachment,
    });
    expect(att.attachments.value).toHaveLength(0);

    sid.value = 'sess_1';
    await nextTick();

    // The media chip hydrated (and persisted itself back, media-only); the
    // file moved to the deferred slot — the seam never ran.
    expect(att.attachments.value).toHaveLength(1);
    expect(att.attachments.value[0]).toMatchObject({ kind: 'image', fileId: 'f_img' });
    expect(adoptFileAttachment).not.toHaveBeenCalled();
    let persisted = JSON.parse(localStorage.getItem('kimi-web.attachment-draft.sess_1') ?? '[]') as Array<{ kind: string }>;
    expect(persisted.map((entry) => entry.kind)).toEqual(['image']);

    // The composer's post-restore drive: the file adopts now (its fileId is
    // reused); the persisted draft stays media-only (no double-adopt later).
    att.adoptStoredFileDrafts();
    expect(adoptFileAttachment).toHaveBeenCalledOnce();
    expect(adoptFileAttachment.mock.calls[0]![0]).toMatchObject({ kind: 'file', fileId: 'f_file', name: 'legacy.pdf' });
    persisted = JSON.parse(localStorage.getItem('kimi-web.attachment-draft.sess_1') ?? '[]') as Array<{ kind: string }>;
    expect(persisted.map((entry) => entry.kind)).toEqual(['image']);
  });

  it('adoptStoredFileDrafts drops the key when the stored draft is files-only, and no-ops afterwards / without the seam', () => {
    seedChipDraft([fileDraft]);
    const sid = ref<string | undefined>('sess_0');
    const adoptFileAttachment = vi.fn<AdoptFileAttachment>();
    const att = useAttachmentUpload({
      api: apiMock,
      uploadImage: () => uploadOk,
      sessionId: () => sid.value,
      adoptFileAttachment,
    });

    sid.value = 'sess_1';
    return nextTick().then(() => {
      // Deferred by the watcher (nothing adopted yet)…
      expect(adoptFileAttachment).not.toHaveBeenCalled();
      att.adoptStoredFileDrafts();
      expect(adoptFileAttachment).toHaveBeenCalledOnce();
      expect(localStorage.getItem('kimi-web.attachment-draft.sess_1')).toBeNull();
      // …and a second drive finds nothing left.
      att.adoptStoredFileDrafts();
      expect(adoptFileAttachment).toHaveBeenCalledOnce();

      // Without the seam the drive never touches storage.
      seedChipDraft([fileDraft]);
      const plain = setup({ uploadImage: uploadOk });
      plain.adoptStoredFileDrafts();
      expect(localStorage.getItem('kimi-web.attachment-draft.sess_1')).not.toBeNull();
    });
  });
});
