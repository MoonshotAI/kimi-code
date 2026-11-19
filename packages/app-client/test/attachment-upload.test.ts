import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAttachmentUpload } from '../src/composables/useAttachmentUpload';
import { noopProductTracker, setProductTracker } from '../src/contracts';

vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue')>();
  return { ...actual, onMounted: vi.fn(), onUnmounted: vi.fn() };
});

const apiMock = {
  getFileBlob: vi.fn(),
  getSessionMediaBlob: vi.fn(),
  getFileUrl: vi.fn((fileId: string) => `https://example.test/api/v1/files/${fileId}`),
  getSessionMediaUrl: vi.fn(
    (sessionId: string, fileId: string) => `https://example.test/api/v1/sessions/${sessionId}/media/${fileId}`,
  ),
};

type UploadImage = (
  file: Blob,
  name?: string,
) => Promise<{ fileId: string; name: string; mediaType: string } | null>;
type InsertFileAttachment = NonNullable<Parameters<typeof useAttachmentUpload>[0]['insertFileAttachment']>;
type InsertFolderPaths = NonNullable<Parameters<typeof useAttachmentUpload>[0]['insertFolderPaths']>;

const uploadOk: UploadImage = async (file, name) => ({
  fileId: 'f1',
  name: name ?? 'n',
  mediaType: (file as File).type || 'application/octet-stream',
});

function setup(options?: {
  uploadImage?: UploadImage;
  insertFileAttachment?: InsertFileAttachment;
  insertFolderPaths?: InsertFolderPaths;
}) {
  return useAttachmentUpload({
    api: apiMock,
    uploadImage: () => options?.uploadImage,
    sessionId: () => 'sess_1',
    insertFileAttachment: options?.insertFileAttachment,
    insertFolderPaths: options?.insertFolderPaths,
  });
}

function inputEvent(files: File[]): Event {
  return { target: { files, value: 'x' } } as unknown as Event;
}

function dropEvent(files: File[], coords?: { clientX: number; clientY: number }) {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    dataTransfer: { files },
    clientX: coords?.clientX ?? 0,
    clientY: coords?.clientY ?? 0,
  };
}

function folderDropEvent(path: string) {
  const stub = new File([''], path.split('/').pop() ?? 'dir');
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    clientX: 10,
    clientY: 20,
    dataTransfer: {
      items: [
        {
          kind: 'file',
          type: '',
          getAsFile: () => stub,
          webkitGetAsEntry: () => ({ isDirectory: true }),
        },
      ],
      files: [stub],
    },
  };
}

function asDrag(event: unknown): DragEvent {
  return event as DragEvent;
}

function stubBridge(): void {
  (globalThis as { window?: unknown }).window = {
    kimiDesktop: { getPathForFile: (file: File) => `/abs/${file.name}` },
  };
}

function unstubBridge(): void {
  delete (globalThis as { window?: unknown }).window;
}

describe('useAttachmentUpload (the pill-intake router)', () => {
  afterEach(() => {
    unstubBridge();
    vi.restoreAllMocks();
  });

  it('routes picked files through the seam in order and resets the input', () => {
    const insertFileAttachment = vi.fn<InsertFileAttachment>().mockReturnValue(true);
    const att = setup({ uploadImage: uploadOk, insertFileAttachment });
    const event = inputEvent([
      new File(['x'], 'shot.png', { type: 'image/png' }),
      new File(['x'], 'a.pdf', { type: 'application/pdf' }),
    ]);

    att.handleFileInputChange(event);

    expect(insertFileAttachment).toHaveBeenCalledTimes(2);
    expect(insertFileAttachment.mock.calls.map((call) => call[0].name)).toEqual(['shot.png', 'a.pdf']);
    expect(insertFileAttachment.mock.calls[0]![2]).toEqual({ source: 'picker' });
    expect((event.target as HTMLInputElement).value).toBe('');
  });

  it('resolves the desktop path through the bridge, null without one', () => {
    stubBridge();
    const insertFileAttachment = vi.fn<InsertFileAttachment>().mockReturnValue(true);
    const att = setup({ uploadImage: uploadOk, insertFileAttachment });

    att.handleFileInputChange(inputEvent([new File(['x'], 'a.pdf', { type: 'application/pdf' })]));
    expect(insertFileAttachment.mock.calls[0]![1]).toBe('/abs/a.pdf');

    unstubBridge();
    att.handleFileInputChange(inputEvent([new File(['x'], 'b.pdf', { type: 'application/pdf' })]));
    expect(insertFileAttachment.mock.calls[1]![1]).toBeNull();
  });

  it('drops a seam-declined file silently (no chip fallback anymore)', () => {
    const spy = vi.fn();
    setProductTracker({ track: spy });
    try {
      const insertFileAttachment = vi.fn<InsertFileAttachment>().mockReturnValue(false);
      const att = setup({ uploadImage: uploadOk, insertFileAttachment });

      att.handleFileInputChange(inputEvent([new File(['x'], 'a.pdf', { type: 'application/pdf' })]));

      expect(insertFileAttachment).toHaveBeenCalledOnce();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      setProductTracker(noopProductTracker);
    }
  });

  it('is a silent no-op without the seam or the upload dep', () => {
    const insertFileAttachment = vi.fn<InsertFileAttachment>().mockReturnValue(true);
    const noSeam = setup({ uploadImage: uploadOk });
    noSeam.handleFileInputChange(inputEvent([new File(['x'], 'a.pdf')]));
    const noUpload = setup({ insertFileAttachment });
    noUpload.handleFileInputChange(inputEvent([new File(['x'], 'a.pdf')]));
    noUpload.handleDrop(asDrag(dropEvent([new File(['x'], 'a.pdf')])));

    expect(insertFileAttachment).not.toHaveBeenCalled();
  });

  it('consumes a file drop (no document-level double-add) and anchors only the first run at the drop point', () => {
    const insertFileAttachment = vi.fn<InsertFileAttachment>().mockReturnValue(true);
    const att = setup({ uploadImage: uploadOk, insertFileAttachment });
    const event = dropEvent(
      [new File(['x'], 'a.pdf'), new File(['x'], 'b.pdf'), new File(['x'], 'c.pdf')],
      { clientX: 120, clientY: 48 },
    );

    att.handleDrop(event as unknown as DragEvent);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(insertFileAttachment.mock.calls.map((call) => [call[0].name, call[2]])).toEqual([
      ['a.pdf', { source: 'drop', at: { clientX: 120, clientY: 48 } }],
      ['b.pdf', { source: 'drop' }],
      ['c.pdf', { source: 'drop' }],
    ]);
  });

  it('routes a dropped folder to insertFolderPaths even without the upload dep', () => {
    stubBridge();
    const insertFolderPaths = vi.fn<InsertFolderPaths>();
    const insertFileAttachment = vi.fn<InsertFileAttachment>().mockReturnValue(true);
    const att = setup({ insertFolderPaths, insertFileAttachment });
    const event = folderDropEvent('/abs/dir');

    att.handleDrop(event as unknown as DragEvent);

    expect(insertFolderPaths).toHaveBeenCalledWith(['/abs/dir']);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(insertFileAttachment).not.toHaveBeenCalled();
  });

  it('leaves a file-only drop alone when attaching is disabled (no upload dep)', () => {
    const att = setup({});
    const event = dropEvent([new File(['x'], 'a.pdf')]);

    att.handleDrop(event as unknown as DragEvent);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });

  it('highlights only file-carrying drags, and only with the upload dep', () => {
    const att = setup({ uploadImage: uploadOk, insertFileAttachment: vi.fn<InsertFileAttachment>().mockReturnValue(true) });
    const textDrag = {
      dataTransfer: { items: [{ kind: 'string' }] },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    att.handleDragOver(textDrag as unknown as DragEvent);
    expect(textDrag.preventDefault).not.toHaveBeenCalled();
    expect(att.isDragOver.value).toBe(false);

    const fileDrag = {
      dataTransfer: { items: [{ kind: 'file' }] },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    att.handleDragOver(fileDrag as unknown as DragEvent);
    expect(fileDrag.preventDefault).toHaveBeenCalled();
    expect(fileDrag.stopPropagation).toHaveBeenCalled();
    expect(att.isDragOver.value).toBe(true);

    att.handleDragLeave();
    expect(att.isDragOver.value).toBe(false);

    const disabled = setup({});
    disabled.handleDragOver(fileDrag as unknown as DragEvent);
    expect(disabled.isDragOver.value).toBe(false);
  });
});

describe('attachment_added tracking', () => {
  let spy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    spy = vi.fn();
    setProductTracker({ track: spy });
  });

  afterEach(() => {
    setProductTracker(noopProductTracker);
  });

  function makeUpload(enabled = true) {
    return setup({
      uploadImage: enabled ? uploadOk : undefined,
      insertFileAttachment: vi.fn<InsertFileAttachment>().mockReturnValue(true),
    });
  }

  it('tracks each picked file as via click with its MIME-derived kind', () => {
    const up = makeUpload();
    up.handleFileInputChange(
      inputEvent([
        new File(['x'], 'shot.png', { type: 'image/png' }),
        new File(['x'], 'notes.pdf', { type: 'application/pdf' }),
      ]),
    );
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenNthCalledWith(1, 'attachment_added', {
      via: 'click',
      kind: 'image',
      size_bucket: '<1mb',
      count: 2,
    });
    expect(spy).toHaveBeenNthCalledWith(2, 'attachment_added', {
      via: 'click',
      kind: 'file',
      size_bucket: '<1mb',
      count: 2,
    });
  });

  it('tracks a composer drop as via drop', () => {
    const up = makeUpload();
    up.handleDrop(asDrag(dropEvent([new File(['x'], 'clip.mp4', { type: 'video/mp4' })])));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('attachment_added', {
      via: 'drop',
      kind: 'video',
      size_bucket: '<1mb',
      count: 1,
    });
  });

  it('buckets the file size around the 1/10/50 MB edges', () => {
    const up = makeUpload();
    const fileOfSize = (size: number) => {
      const f = new File(['x'], 'big.bin', { type: 'application/octet-stream' });
      Object.defineProperty(f, 'size', { value: size });
      return f;
    };
    up.handleFileInputChange(
      inputEvent([
        fileOfSize(1024 * 1024),
        fileOfSize(10 * 1024 * 1024),
        fileOfSize(50 * 1024 * 1024),
      ]),
    );
    expect(spy).toHaveBeenCalledTimes(3);
    const buckets = spy.mock.calls.map((call) => (call[1] as { size_bucket: string }).size_bucket);
    expect(buckets).toEqual(['1-10mb', '10-50mb', '50mb+']);
    for (const call of spy.mock.calls) {
      expect((call[1] as { count: number }).count).toBe(3);
    }
  });

  it('tracks nothing when attaching is disabled (no upload dep)', () => {
    const up = makeUpload(false);
    up.handleFileInputChange(inputEvent([new File(['x'], 'shot.png', { type: 'image/png' })]));
    up.handleDrop(asDrag(dropEvent([new File(['x'], 'shot.png', { type: 'image/png' })])));
    expect(spy).not.toHaveBeenCalled();
  });
});
