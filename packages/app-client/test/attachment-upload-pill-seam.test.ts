import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { useAttachmentUpload } from '../src/composables/useAttachmentUpload';
import { noopProductTracker, setProductTracker } from '../src/contracts';

const docListeners = new Map<string, (e: Event) => void>();
vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue')>();
  return { ...actual, onMounted: vi.fn((cb: () => void) => cb()), onUnmounted: vi.fn() };
});
(globalThis as { document?: unknown }).document = {
  addEventListener: (type: string, fn: (e: Event) => void) => docListeners.set(type, fn),
  removeEventListener: (type: string) => docListeners.delete(type),
};

function paste(files: File[]): void {
  docListeners.get('paste')?.(pasteEvent(files) as unknown as Event);
}

const apiMock = {
  getFileBlob: vi.fn(async () => new Blob(['x'], { type: 'image/png' })),
  getSessionMediaBlob: vi.fn(async () => new Blob(['x'], { type: 'image/png' })),
  getFileUrl: (id: string) => `/files/${id}`,
  getSessionMediaUrl: (sid: string, id: string) => `/sessions/${sid}/media/${id}`,
};

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
type InsertFileAttachments = NonNullable<
  Parameters<typeof useAttachmentUpload>[0]['insertFileAttachments']
>;
type AdoptFileAttachment = NonNullable<
  Parameters<typeof useAttachmentUpload>[0]['adoptFileAttachment']
>;
type AdoptMediaAttachment = NonNullable<
  Parameters<typeof useAttachmentUpload>[0]['adoptMediaAttachment']
>;

function setup(options?: {
  uploadImage?: UploadImage;
  insertFileAttachment?: InsertFileAttachment;
  insertFileAttachments?: InsertFileAttachments;
  adoptFileAttachment?: AdoptFileAttachment;
  adoptMediaAttachment?: AdoptMediaAttachment;
  pasteTarget?: () => 'editor' | 'composer' | 'ignore';
}) {
  return useAttachmentUpload({
    api: apiMock,
    uploadImage: () => options?.uploadImage,
    sessionId: () => 'sess_1',
    insertFileAttachment: options?.insertFileAttachment,
    insertFileAttachments: options?.insertFileAttachments,
    adoptFileAttachment: options?.adoptFileAttachment,
    adoptMediaAttachment: options?.adoptMediaAttachment,
    pasteTarget: options?.pasteTarget,
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

function pasteEvent(files: File[], preventDefault = vi.fn()): ClipboardEvent {
  return {
    preventDefault,
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

function stubBridge(): void {
  (globalThis as { window?: unknown }).window = {
    kimiDesktop: { getPathForFile: (file: File) => `/abs/${file.name}` },
  };
}

function unstubBridge(): void {
  delete (globalThis as { window?: unknown }).window;
}

describe('insertFileAttachment seam', () => {
  afterEach(() => {
    unstubBridge();
    vi.restoreAllMocks();
  });

  it('routes a picked file to the seam with its bridge-resolved path', () => {
    stubBridge();
    const insertFileAttachment = vi.fn<InsertFileAttachment>().mockReturnValue(true);
    const att = setup({ uploadImage: uploadOk, insertFileAttachment });

    att.handleFileInputChange(inputEvent([pdfFile()]));

    expect(insertFileAttachment).toHaveBeenCalledOnce();
    const [file, path, context] = insertFileAttachment.mock.calls[0]!;
    expect((file as File).name).toBe('a.pdf');
    expect(path).toBe('/abs/a.pdf');
    expect(context).toEqual({ source: 'picker' });
  });

  it('passes null as the path when the bridge cannot resolve it (pasted bytes)', () => {
    const insertFileAttachment = vi.fn<InsertFileAttachment>().mockReturnValue(true);
    const att = setup({ uploadImage: uploadOk, insertFileAttachment });

    att.handleFileInputChange(inputEvent([pdfFile()]));

    expect(insertFileAttachment).toHaveBeenCalledOnce();
    expect(insertFileAttachment.mock.calls[0]![1]).toBeNull();
  });

  it('routes media files to the seam too (a media pill, not a chip)', () => {
    const insertFileAttachment = vi.fn<InsertFileAttachment>().mockReturnValue(true);
    const att = setup({ uploadImage: uploadOk, insertFileAttachment });

    att.handleFileInputChange(
      inputEvent([new File(['x'], 'shot.png', { type: 'image/png' })]),
    );

    expect(insertFileAttachment).toHaveBeenCalledOnce();
    expect(insertFileAttachment.mock.calls[0]![0].name).toBe('shot.png');
  });

  it('forwards drop coordinates so the pill can land at the drop point', () => {
    const insertFileAttachment = vi.fn<InsertFileAttachment>().mockReturnValue(true);
    const att = setup({ uploadImage: uploadOk, insertFileAttachment });

    att.handleDrop(dropEvent([pdfFile()], { clientX: 120, clientY: 48 }));

    expect(insertFileAttachment).toHaveBeenCalledOnce();
    expect(insertFileAttachment.mock.calls[0]![2]).toEqual({
      source: 'drop',
      at: { clientX: 120, clientY: 48 },
    });
  });

  it('anchors only the first file of a dropped batch at the drop point — later ones append in order', () => {
    const insertFileAttachment = vi.fn<InsertFileAttachment>().mockReturnValue(true);
    const att = setup({ uploadImage: uploadOk, insertFileAttachment });

    att.handleDrop(dropEvent([pdfFile('a.pdf'), pdfFile('b.pdf'), pdfFile('c.pdf')], { clientX: 120, clientY: 48 }));

    expect(insertFileAttachment).toHaveBeenCalledTimes(3);
    expect(insertFileAttachment.mock.calls.map((call) => [call[0].name, call[2]])).toEqual([
      ['a.pdf', { source: 'drop', at: { clientX: 120, clientY: 48 } }],
      ['b.pdf', { source: 'drop' }],
      ['c.pdf', { source: 'drop' }],
    ]);
  });

  it('gives the coordinates to the first file the seam ACCEPTS (a declined first file passes them on)', () => {
    const insertFileAttachment = vi.fn<InsertFileAttachment>()
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    const att = setup({ uploadImage: uploadOk, insertFileAttachment });

    att.handleDrop(dropEvent([pdfFile('a.pdf'), pdfFile('b.pdf')], { clientX: 120, clientY: 48 }));

    expect(insertFileAttachment.mock.calls.map((call) => call[2])).toEqual([
      { source: 'drop', at: { clientX: 120, clientY: 48 } },
      { source: 'drop', at: { clientX: 120, clientY: 48 } },
    ]);
  });

  it('routes a pasted file to the seam (no coordinates)', () => {
    const insertFileAttachment = vi.fn<InsertFileAttachment>().mockReturnValue(true);
    setup({ uploadImage: uploadOk, insertFileAttachment });

    paste([pdfFile()]);

    expect(insertFileAttachment).toHaveBeenCalledOnce();
    expect(insertFileAttachment.mock.calls[0]![2]).toEqual({ source: 'paste-editor' });
  });

  it('does not intercept a media paste owned by another editable surface', () => {
    const insertFileAttachment = vi.fn<InsertFileAttachment>().mockReturnValue(true);
    setup({ uploadImage: uploadOk, insertFileAttachment, pasteTarget: () => 'ignore' });
    const preventDefault = vi.fn();
    const event = pasteEvent([pdfFile()], preventDefault);

    docListeners.get('paste')?.(event as unknown as Event);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(insertFileAttachment).not.toHaveBeenCalled();
  });

  it('marks a composer-chrome paste as inventory-only context', () => {
    const insertFileAttachment = vi.fn<InsertFileAttachment>().mockReturnValue(true);
    setup({ uploadImage: uploadOk, insertFileAttachment, pasteTarget: () => 'composer' });

    paste([new File(['x'], 'shot.png', { type: 'image/png' })]);

    expect(insertFileAttachment.mock.calls[0]![2]).toEqual({ source: 'paste-composer' });
  });

  it('routes a mixed batch to the seam in order (files and media alike)', () => {
    const insertFileAttachment = vi.fn<InsertFileAttachment>().mockReturnValue(true);
    const att = setup({ uploadImage: uploadOk, insertFileAttachment });

    att.handleFileInputChange(
      inputEvent([new File(['x'], 'shot.png', { type: 'image/png' }), pdfFile()]),
    );

    expect(insertFileAttachment).toHaveBeenCalledTimes(2);
    expect(insertFileAttachment.mock.calls.map((call) => call[0].name)).toEqual(['shot.png', 'a.pdf']);
  });

  it('routes one intake run through the batch seam as one operation', () => {
    const insertFileAttachments = vi.fn<InsertFileAttachments>().mockReturnValue([true, true]);
    const att = setup({ uploadImage: uploadOk, insertFileAttachments });

    att.handleDrop(dropEvent([pdfFile('a.pdf'), pdfFile('b.pdf')], { clientX: 120, clientY: 48 }));

    expect(insertFileAttachments).toHaveBeenCalledOnce();
    expect(insertFileAttachments.mock.calls[0]![0].map((item) => item.file.name)).toEqual(['a.pdf', 'b.pdf']);
    expect(insertFileAttachments.mock.calls[0]![1]).toEqual({
      source: 'drop',
      at: { clientX: 120, clientY: 48 },
    });
  });

  it('does not call the seam when attaching is disabled (no upload dep)', () => {
    const insertFileAttachment = vi.fn<InsertFileAttachment>().mockReturnValue(true);
    const att = setup({ insertFileAttachment });

    att.handleFileInputChange(inputEvent([pdfFile()]));
    att.handleDrop(dropEvent([pdfFile()]));
    paste([pdfFile()]);

    expect(insertFileAttachment).not.toHaveBeenCalled();
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

describe('chip-era draft adoption', () => {
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

  function seedChipDraft(entries: Array<Record<string, unknown>>, sid = 'sess_1'): void {
    localStorage.setItem(`kimi-web.attachment-draft.${sid}`, JSON.stringify(entries));
  }

  const fileDraft = { fileId: 'f_file', kind: 'file', name: 'legacy.pdf', mediaType: 'application/pdf', size: 24 };
  const imageDraft = { fileId: 'f_img', kind: 'image', name: 'shot.png', mediaType: 'image/png', size: 99 };

  it('defers every kind at hydrate and adopts through the two seams on adoptStoredDrafts', () => {
    seedChipDraft([fileDraft, imageDraft]);
    const adoptFileAttachment = vi.fn<AdoptFileAttachment>();
    const adoptMediaAttachment = vi.fn<AdoptMediaAttachment>();
    const att = setup({ uploadImage: uploadOk, adoptFileAttachment, adoptMediaAttachment });

    expect(adoptFileAttachment).not.toHaveBeenCalled();
    expect(adoptMediaAttachment).not.toHaveBeenCalled();
    expect(localStorage.getItem('kimi-web.attachment-draft.sess_1')).toBeNull();

    att.adoptStoredDrafts();
    expect(adoptFileAttachment).toHaveBeenCalledOnce();
    expect(adoptFileAttachment.mock.calls[0]![0]).toMatchObject({ kind: 'file', fileId: 'f_file', name: 'legacy.pdf' });
    expect(adoptMediaAttachment).toHaveBeenCalledOnce();
    expect(adoptMediaAttachment.mock.calls[0]![0]).toMatchObject({ kind: 'image', fileId: 'f_img', name: 'shot.png' });

    att.adoptStoredDrafts();
    expect(adoptFileAttachment).toHaveBeenCalledOnce();
    expect(adoptMediaAttachment).toHaveBeenCalledOnce();
  });

  it('drops the stored draft without adoption when no adopt seams exist', () => {
    seedChipDraft([fileDraft, imageDraft]);
    const att = setup({ uploadImage: uploadOk });

    expect(localStorage.getItem('kimi-web.attachment-draft.sess_1')).toBeNull();
    att.adoptStoredDrafts();
  });

  it('skips malformed entries and adopts only the well-formed ones', () => {
    localStorage.setItem('kimi-web.attachment-draft.sess_1', 'not json{');
    const adoptFileAttachment = vi.fn<AdoptFileAttachment>();
    setup({ uploadImage: uploadOk, adoptFileAttachment });
    expect(adoptFileAttachment).not.toHaveBeenCalled();

    seedChipDraft([{ kind: 'image', name: 'no-file-id.png' }, null, fileDraft]);
    const adoptFileAttachment2 = vi.fn<AdoptFileAttachment>();
    const att2 = setup({ uploadImage: uploadOk, adoptFileAttachment: adoptFileAttachment2 });
    att2.adoptStoredDrafts();
    expect(adoptFileAttachment2).toHaveBeenCalledOnce();
    expect(adoptFileAttachment2.mock.calls[0]![0]).toMatchObject({ fileId: 'f_file', name: 'legacy.pdf' });
  });

  it('defers the adoption on a session switch until the composer drives it', () => {
    seedChipDraft([fileDraft, imageDraft]);
    const sid = ref<string | undefined>('sess_0');
    const adoptFileAttachment = vi.fn<AdoptFileAttachment>();
    const adoptMediaAttachment = vi.fn<AdoptMediaAttachment>();
    const att = useAttachmentUpload({
      api: apiMock,
      uploadImage: () => uploadOk,
      sessionId: () => sid.value,
      adoptFileAttachment,
      adoptMediaAttachment,
    });

    sid.value = 'sess_1';
    return nextTick().then(() => {
      expect(adoptFileAttachment).not.toHaveBeenCalled();
      expect(adoptMediaAttachment).not.toHaveBeenCalled();
      expect(localStorage.getItem('kimi-web.attachment-draft.sess_1')).toBeNull();

      att.adoptStoredDrafts();
      expect(adoptFileAttachment).toHaveBeenCalledOnce();
      expect(adoptMediaAttachment).toHaveBeenCalledOnce();
    });
  });
});
