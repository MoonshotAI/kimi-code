import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { useAttachmentUpload } from '../src/composables/useAttachmentUpload';
import { attachmentDraftStorageKey } from '@moonshot-ai/app-core/lib';

// Same lifecycle stub as attachment-upload.test.ts — no active component
// instance in a unit test, so onMounted/onUnmounted would warn. onUnmounted
// callbacks are captured so tests can simulate the composer unmounting.
const unmountCallbacks: Array<() => void> = [];
vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue')>();
  return {
    ...actual,
    onMounted: vi.fn(),
    onUnmounted: vi.fn((cb: () => void) => {
      unmountCallbacks.push(cb);
    }),
  };
});

/** Run the most recently registered instance's unmount hook. */
function unmountLast(): void {
  const cb = unmountCallbacks.pop();
  if (!cb) throw new Error('no onUnmounted callback registered');
  cb();
}

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

function setup(uploadImage: UploadImage | undefined, sid: string | null = 'sess-1') {
  return useAttachmentUpload({
    api: apiMock,
    uploadImage: () => uploadImage,
    sessionId: () => sid ?? undefined,
  });
}

function imageFile(name: string): File {
  return { name, type: 'image/png', size: 10 } as unknown as File;
}

function inputEvent(files: File[]): Event {
  return { target: { files, value: 'x' } } as unknown as Event;
}

/** Flush the addFiles upload → patch promise chain. */
function flushUploads(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function storedDraft(sid: string | undefined): unknown {
  const raw = globalThis.localStorage.getItem(attachmentDraftStorageKey(sid));
  return raw === null ? null : JSON.parse(raw);
}

describe('useAttachmentUpload draft persistence', () => {
  let original: Storage | undefined;
  let originalDocument: Document | undefined;
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    unmountCallbacks.length = 0;
    original = (globalThis as { localStorage?: Storage }).localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      value: memoryStorage(),
      configurable: true,
      writable: true,
    });
    // The unmount hook removes its document-level listeners; node has no
    // document, so stub one for the tests that fire the hook.
    originalDocument = (globalThis as { document?: Document }).document;
    Object.defineProperty(globalThis, 'document', {
      value: { addEventListener: () => {}, removeEventListener: () => {} },
      configurable: true,
      writable: true,
    });
    createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
    revokeObjectURL = vi.fn();
    (globalThis.URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL;
    (globalThis.URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeObjectURL;
    apiMock.getFileBlob.mockReset().mockResolvedValue(new Blob(['x']));
    apiMock.getSessionMediaBlob.mockReset().mockResolvedValue(new Blob(['x']));
    apiMock.getFileUrl.mockClear();
    apiMock.getSessionMediaUrl.mockClear();
  });

  afterEach(() => {
    if (original === undefined) {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    } else {
      Object.defineProperty(globalThis, 'localStorage', {
        value: original,
        configurable: true,
        writable: true,
      });
    }
    if (originalDocument === undefined) {
      delete (globalThis as { document?: Document }).document;
    } else {
      Object.defineProperty(globalThis, 'document', {
        value: originalDocument,
        configurable: true,
        writable: true,
      });
    }
    vi.restoreAllMocks();
  });

  it('persists an attachment once its upload completes, not while in flight', async () => {
    let resolveUpload: (value: { fileId: string; name: string; mediaType: string }) => void = () => {};
    const uploadImage = vi.fn<UploadImage>().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpload = resolve;
        }),
    );
    const att = setup(uploadImage);
    att.handleFileInputChange(inputEvent([imageFile('a.png')]));

    // In-flight: nothing restorable yet — the storage key stays absent.
    expect(storedDraft('sess-1')).toBeNull();

    resolveUpload({ fileId: 'f1', name: 'a.png', mediaType: 'image/png' });
    await flushUploads();

    expect(storedDraft('sess-1')).toEqual([
      { fileId: 'f1', kind: 'image', name: 'a.png', mediaType: 'image/png', size: 10 },
    ]);
  });

  it('drops a failed upload from the persisted draft', async () => {
    const uploadImage = vi.fn<UploadImage>().mockResolvedValue(null);
    const att = setup(uploadImage);
    att.handleFileInputChange(inputEvent([imageFile('a.png')]));
    await flushUploads();

    expect(att.attachments.value[0]).toMatchObject({ uploading: false, error: true });
    expect(storedDraft('sess-1')).toBeNull();
  });

  it('scopes the New Session composer (no session id) under the __new__ key', async () => {
    const uploadImage = vi.fn<UploadImage>().mockResolvedValue({ fileId: 'f1', name: 'a.png', mediaType: 'image/png' });
    const att = setup(uploadImage, null);
    att.handleFileInputChange(inputEvent([imageFile('a.png')]));
    await flushUploads();

    expect(storedDraft(undefined)).toEqual([
      { fileId: 'f1', kind: 'image', name: 'a.png', mediaType: 'image/png', size: 10 },
    ]);
    expect(storedDraft('sess-1')).toBeNull();
  });

  it('restores a persisted image draft on a fresh instance and refetches its thumbnail', async () => {
    apiMock.getFileBlob.mockResolvedValue(new Blob(['x']));
    globalThis.localStorage.setItem(
      attachmentDraftStorageKey('sess-1'),
      JSON.stringify([{ fileId: 'f_img', kind: 'image', name: 'shot.png', mediaType: 'image/png', size: 42 }]),
    );

    const att = setup(undefined);

    expect(att.attachments.value).toHaveLength(1);
    expect(att.attachments.value[0]).toMatchObject({
      fileId: 'f_img',
      kind: 'image',
      name: 'shot.png',
      mediaType: 'image/png',
      size: 42,
      uploading: false,
      // The protected file URL stands in until the authed blob lands.
      previewUrl: 'https://example.test/api/v1/files/f_img',
    });
    expect(apiMock.getFileBlob).toHaveBeenCalledWith('f_img');
    await vi.waitFor(() => {
      expect(att.attachments.value[0].previewUrl).toBe('blob:mock-url');
    });
  });

  it('restores a session-media draft via the session media store URLs', async () => {
    apiMock.getSessionMediaBlob.mockResolvedValue(new Blob(['x']));
    globalThis.localStorage.setItem(
      attachmentDraftStorageKey('sess-1'),
      JSON.stringify([
        { fileId: 'm_img', kind: 'image', name: 'history.png', mediaType: 'image/png', sessionId: 'sess-1' },
      ]),
    );

    const att = setup(undefined);

    expect(att.attachments.value[0]).toMatchObject({
      fileId: 'm_img',
      kind: 'image',
      sessionId: 'sess-1',
      previewUrl: 'https://example.test/api/v1/sessions/sess-1/media/m_img',
    });
    expect(apiMock.getSessionMediaBlob).toHaveBeenCalledWith('sess-1', 'm_img');
    expect(apiMock.getFileBlob).not.toHaveBeenCalled();
  });

  it('restores a file draft without fetching a thumbnail', () => {
    globalThis.localStorage.setItem(
      attachmentDraftStorageKey('sess-1'),
      JSON.stringify([{ fileId: 'f_pdf', kind: 'file', name: 'a.pdf', mediaType: 'application/pdf', size: 7 }]),
    );

    const att = setup(undefined);

    expect(att.attachments.value).toHaveLength(1);
    expect(att.attachments.value[0]).toMatchObject({
      fileId: 'f_pdf',
      kind: 'file',
      name: 'a.pdf',
      uploading: false,
      previewUrl: undefined,
    });
    expect(apiMock.getFileBlob).not.toHaveBeenCalled();
  });

  it('rewrites the persisted draft on remove and drops the key when emptied', async () => {
    const uploadImage = vi.fn<UploadImage>().mockResolvedValue({ fileId: 'f1', name: 'a.png', mediaType: 'image/png' });
    const att = setup(uploadImage);
    att.handleFileInputChange(inputEvent([imageFile('a.png'), imageFile('b.png')]));
    await flushUploads();
    expect((storedDraft('sess-1') as unknown[]).length).toBe(2);

    att.removeAttachment(att.attachments.value[0].localId);
    expect((storedDraft('sess-1') as Array<{ name: string }>).map((a) => a.name)).toEqual(['b.png']);

    att.removeAttachment(att.attachments.value[0].localId);
    expect(storedDraft('sess-1')).toBeNull();
  });

  it('clears the persisted draft on submit so a remount restores nothing', async () => {
    // Regression: the optimistic first message unmounts the composer in the
    // same flush as the submit — the clear must hit storage synchronously or
    // the remount resurrects attachments that were already sent.
    const uploadImage = vi.fn<UploadImage>().mockResolvedValue({ fileId: 'f1', name: 'a.png', mediaType: 'image/png' });
    const att = setup(uploadImage);
    att.handleFileInputChange(inputEvent([imageFile('a.png')]));
    await flushUploads();
    expect(storedDraft('sess-1')).not.toBeNull();

    att.clearAfterSubmit();
    // No nextTick — the write is synchronous.
    expect(storedDraft('sess-1')).toBeNull();

    const remounted = setup(undefined);
    expect(remounted.attachments.value).toHaveLength(0);
  });

  it('hydrates a session first visited after a switch, from its persisted draft', async () => {
    globalThis.localStorage.setItem(
      attachmentDraftStorageKey('sess-2'),
      JSON.stringify([{ fileId: 'f_other', kind: 'image', name: 'other.png' }]),
    );
    const sid = ref<string | undefined>('sess-1');
    const att = useAttachmentUpload({
      api: apiMock,
      uploadImage: () => undefined,
      sessionId: () => sid.value,
    });
    expect(att.attachments.value).toHaveLength(0);

    sid.value = 'sess-2';
    await nextTick();

    expect(att.attachments.value).toHaveLength(1);
    expect(att.attachments.value[0]).toMatchObject({ fileId: 'f_other', name: 'other.png' });
  });

  it('keeps live in-memory state when revisiting a session within one mount', async () => {
    const uploadImage = vi.fn<UploadImage>().mockResolvedValue({ fileId: 'f1', name: 'a.png', mediaType: 'image/png' });
    const sid = ref<string | undefined>('sess-1');
    const att = useAttachmentUpload({
      api: apiMock,
      uploadImage: () => uploadImage,
      sessionId: () => sid.value,
    });
    att.handleFileInputChange(inputEvent([imageFile('a.png')]));
    await flushUploads();

    sid.value = 'sess-2';
    await nextTick();
    expect(att.attachments.value).toHaveLength(0);

    // Back to sess-1: the live map (with its object URL) wins — no rehydrate,
    // no duplicate chip.
    sid.value = 'sess-1';
    await nextTick();
    expect(att.attachments.value).toHaveLength(1);
    expect(att.attachments.value[0]).toMatchObject({ fileId: 'f1', name: 'a.png' });
  });

  it('hydrates nothing from a malformed payload', () => {
    globalThis.localStorage.setItem(attachmentDraftStorageKey('sess-1'), 'not json{');
    expect(setup(undefined).attachments.value).toHaveLength(0);

    globalThis.localStorage.setItem(attachmentDraftStorageKey('sess-1'), JSON.stringify({ nope: true }));
    expect(setup(undefined).attachments.value).toHaveLength(0);

    globalThis.localStorage.setItem(
      attachmentDraftStorageKey('sess-1'),
      JSON.stringify([{ kind: 'image', name: 'no-file-id.png' }, null, { fileId: 'f_ok', kind: 'image', name: 'ok.png' }]),
    );
    const att = setup(undefined);
    expect(att.attachments.value).toHaveLength(1);
    expect(att.attachments.value[0]).toMatchObject({ fileId: 'f_ok', name: 'ok.png' });
  });

  it('drops a thumbnail blob that lands after unmount instead of leaking the object URL', async () => {
    // The unmount hook can only revoke URLs that already exist — a blob that
    // resolves afterwards must be discarded without ever creating one.
    let resolveBlob: (blob: Blob) => void = () => {};
    apiMock.getFileBlob.mockReset().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveBlob = resolve;
        }),
    );
    globalThis.localStorage.setItem(
      attachmentDraftStorageKey('sess-1'),
      JSON.stringify([{ fileId: 'f_img', kind: 'image', name: 'a.png' }]),
    );
    const att = setup(undefined);
    expect(apiMock.getFileBlob).toHaveBeenCalledWith('f_img');
    expect(createObjectURL).not.toHaveBeenCalled();

    unmountLast();
    resolveBlob(new Blob(['x']));
    await flushUploads();

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(att.attachments.value[0].previewUrl).toBe('https://example.test/api/v1/files/f_img');
  });

  it('does not persist an upload that completes after unmount over a newer draft', async () => {
    // Stale instance: its upload is still in flight when the composer unmounts.
    let resolveStale: (value: { fileId: string; name: string; mediaType: string }) => void = () => {};
    const staleUpload = vi.fn<UploadImage>().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStale = resolve;
        }),
    );
    const stale = setup(staleUpload);
    stale.handleFileInputChange(inputEvent([imageFile('stale.png')]));
    unmountLast();

    // New instance for the same session: the user attaches something else and
    // it persists.
    const freshUpload = vi.fn<UploadImage>().mockResolvedValue({ fileId: 'f_new', name: 'new.png', mediaType: 'image/png' });
    const fresh = setup(freshUpload);
    fresh.handleFileInputChange(inputEvent([imageFile('new.png')]));
    await flushUploads();
    expect(storedDraft('sess-1')).toEqual([
      { fileId: 'f_new', kind: 'image', name: 'new.png', mediaType: 'image/png', size: 10 },
    ]);

    // The dead instance's upload finally resolves — it must not overwrite the
    // newer draft (nor resurrect its own attachment on the next mount).
    resolveStale({ fileId: 'f_stale', name: 'stale.png', mediaType: 'image/png' });
    await flushUploads();
    expect(storedDraft('sess-1')).toEqual([
      { fileId: 'f_new', kind: 'image', name: 'new.png', mediaType: 'image/png', size: 10 },
    ]);
  });
});
