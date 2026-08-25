import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { useAttachmentUpload } from '../src/composables/useAttachmentUpload';
import { attachmentDraftStorageKey } from '@moonshot-ai/app-core/lib';
import type { TurnAttachment } from '@moonshot-ai/app-core/client';

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

/** Stub global fetch for the URL-reupload refill path (urlToBlob). Returns
 *  the restore function. */
function stubUrlFetch(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    blob: () => Promise.resolve(new Blob(['x'], { type: 'image/png' })),
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
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
      { localId: expect.any(String), fileId: 'f1', kind: 'image', name: 'a.png', mediaType: 'image/png', size: 10, seq: expect.any(Number) },
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
      { localId: expect.any(String), fileId: 'f1', kind: 'image', name: 'a.png', mediaType: 'image/png', size: 10, seq: expect.any(Number) },
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

  it('round-trips the chip’s add-order stamp (seq) instead of re-stamping on hydrate', () => {
    // A remount must keep the persisted stamp verbatim — re-stamping would
    // scramble the payload's media/file interleave (only a missing stamp
    // gets a fresh one at load).
    globalThis.localStorage.setItem(
      attachmentDraftStorageKey('sess-1'),
      JSON.stringify([{ fileId: 'f_img', kind: 'image', name: 'shot.png', mediaType: 'image/png', size: 42, seq: 4242 }]),
    );

    const att = setup(undefined);

    expect(att.attachments.value).toHaveLength(1);
    expect(att.attachments.value[0]).toMatchObject({ fileId: 'f_img', seq: 4242 });
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

  it('merges an upload that completes after unmount into the newer draft instead of clobbering it', async () => {
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
      { localId: expect.any(String), fileId: 'f_new', kind: 'image', name: 'new.png', mediaType: 'image/png', size: 10, seq: expect.any(Number) },
    ]);

    // The dead instance's upload finally resolves. Its attachment was neither
    // submitted nor removed, so the module-level settle MERGES it into the
    // stored draft (storage-layer merge by localId) — the newer entry stays,
    // and the draft is re-sorted into ADD order (stale.png was attached
    // first, so its seq predates new.png's): completion order can't scramble
    // the restored strip.
    resolveStale({ fileId: 'f_stale', name: 'stale.png', mediaType: 'image/png' });
    await flushUploads();
    expect(storedDraft('sess-1')).toEqual([
      { localId: expect.any(String), fileId: 'f_stale', kind: 'image', name: 'stale.png', mediaType: 'image/png', size: 10, seq: expect.any(Number) },
      { localId: expect.any(String), fileId: 'f_new', kind: 'image', name: 'new.png', mediaType: 'image/png', size: 10, seq: expect.any(Number) },
    ]);
  });

  it('keeps the stored draft in add order when late settles complete out of order', async () => {
    // Three images added together, the composer unmounts, and the uploads
    // settle in REVERSE completion order: the storage merge re-sorts by the
    // add-order stamp, so the restored strip (and the submit payload, which
    // interleaves by seq) matches the user's selection order.
    const resolvers: Array<(value: { fileId: string; name: string; mediaType: string }) => void> = [];
    const uploadImage = vi.fn<UploadImage>().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const att = setup(uploadImage);
    att.handleFileInputChange(inputEvent([imageFile('a.png'), imageFile('b.png'), imageFile('c.png')]));
    unmountLast();

    // Settle c, then a, then b — completion order ≠ add order.
    resolvers[2]({ fileId: 'f_c', name: 'c.png', mediaType: 'image/png' });
    await flushUploads();
    resolvers[0]({ fileId: 'f_a', name: 'a.png', mediaType: 'image/png' });
    await flushUploads();
    resolvers[1]({ fileId: 'f_b', name: 'b.png', mediaType: 'image/png' });
    await flushUploads();

    const stored = storedDraft('sess-1') as Array<Record<string, unknown>>;
    expect(stored.map((entry) => entry.fileId)).toEqual(['f_a', 'f_b', 'f_c']);
  });

  it('restores a chip whose upload completed while the composer was unmounted', async () => {
    // The reported bug: attach an image, switch sessions before the upload
    // finishes, switch back — the chip used to be gone for good.
    let resolveUpload: (value: { fileId: string; name: string; mediaType: string }) => void = () => {};
    const uploadImage = vi.fn<UploadImage>().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpload = resolve;
        }),
    );
    const first = setup(uploadImage);
    first.handleFileInputChange(inputEvent([imageFile('late.png')]));
    // Switch away mid-upload: the composer unmounts, the upload keeps running
    // (an unmount never aborts it).
    unmountLast();

    resolveUpload({ fileId: 'f_late', name: 'late.png', mediaType: 'image/png' });
    await flushUploads();

    // The module-level settle landed the fileId in the stored draft…
    expect(storedDraft('sess-1')).toEqual([
      { localId: expect.any(String), fileId: 'f_late', kind: 'image', name: 'late.png', mediaType: 'image/png', size: 10, seq: expect.any(Number) },
    ]);
    // …so switching back (a fresh instance hydrating from storage) restores
    // the chip, ready to send.
    const remounted = setup(undefined);
    expect(remounted.attachments.value).toHaveLength(1);
    expect(remounted.attachments.value[0]).toMatchObject({
      fileId: 'f_late',
      kind: 'image',
      name: 'late.png',
      uploading: false,
    });
  });

  it('delivers a settle that lands after a remount to the LIVE composer strip', async () => {
    // P1 regression: attach on the New Session page, switch away mid-upload,
    // switch BACK before the upload finishes — the remounted composer
    // hydrates an empty storage draft, then the upload settles. The chip
    // must appear in the LIVE strip (so handleSubmit's payload carries it),
    // not only in storage for the next mount.
    let resolveUpload: (value: { fileId: string; name: string; mediaType: string }) => void = () => {};
    const uploadImage = vi.fn<UploadImage>().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpload = resolve;
        }),
    );
    const first = setup(uploadImage);
    first.handleFileInputChange(inputEvent([imageFile('late.png')]));
    // Switch away mid-upload: the composer unmounts, the upload keeps running.
    unmountLast();

    // Switch back BEFORE the upload settles: the fresh instance hydrates an
    // empty storage draft — but restores the still-in-flight upload from the
    // module registry as an uploading chip, so the strip is never blank.
    const remounted = setup(undefined);
    expect(remounted.attachments.value).toHaveLength(1);
    expect(remounted.attachments.value[0]).toMatchObject({
      kind: 'image',
      name: 'late.png',
      uploading: true,
    });

    resolveUpload({ fileId: 'f_late', name: 'late.png', mediaType: 'image/png' });
    await flushUploads();

    // The module-level settle landed the fileId in the stored draft…
    expect(storedDraft('sess-1')).toEqual([
      { localId: expect.any(String), fileId: 'f_late', kind: 'image', name: 'late.png', mediaType: 'image/png', size: 10, seq: expect.any(Number) },
    ]);
    // …AND swapped the restored uploading chip for the ready entry in the
    // live strip — a submit now (handleSubmit reads `attachments`) includes
    // the image.
    expect(remounted.attachments.value).toHaveLength(1);
    expect(remounted.attachments.value[0]).toMatchObject({
      fileId: 'f_late',
      kind: 'image',
      name: 'late.png',
      uploading: false,
    });
  });

  it('does not duplicate the chip when the settle is delivered to its own originating instance', async () => {
    // The instance that added the file is still mounted and registered when
    // its upload settles: delivery dedups by localId, and the completion
    // handler patches the existing chip — one chip, ready.
    let resolveUpload: (value: { fileId: string; name: string; mediaType: string }) => void = () => {};
    const uploadImage = vi.fn<UploadImage>().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpload = resolve;
        }),
    );
    const att = setup(uploadImage);
    att.handleFileInputChange(inputEvent([imageFile('a.png')]));
    expect(att.attachments.value).toHaveLength(1);

    resolveUpload({ fileId: 'f1', name: 'a.png', mediaType: 'image/png' });
    await flushUploads();

    expect(att.attachments.value).toHaveLength(1);
    expect(att.attachments.value[0]).toMatchObject({ fileId: 'f1', uploading: false, error: false });
  });

  it('does not resurrect an attachment whose upload completes after submit', async () => {
    // Submit consumes the session's in-flight uploads — a completion landing
    // afterwards must find no registry entry and drop, or the next mount
    // would bring back an attachment that was already sent.
    let resolveUpload: (value: { fileId: string; name: string; mediaType: string }) => void = () => {};
    const uploadImage = vi.fn<UploadImage>().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpload = resolve;
        }),
    );
    const first = setup(uploadImage);
    first.handleFileInputChange(inputEvent([imageFile('sent.png')]));
    first.clearAfterSubmit();
    unmountLast();

    resolveUpload({ fileId: 'f_sent', name: 'sent.png', mediaType: 'image/png' });
    await flushUploads();

    expect(storedDraft('sess-1')).toBeNull();
    const remounted = setup(undefined);
    expect(remounted.attachments.value).toHaveLength(0);
  });

  it('does not write back an attachment the user removed before its upload completed', async () => {
    // Manual removal consumes the registry entry too — otherwise a late
    // completion would write the deleted image back into the stored draft.
    let resolveUpload: (value: { fileId: string; name: string; mediaType: string }) => void = () => {};
    const uploadImage = vi.fn<UploadImage>().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpload = resolve;
        }),
    );
    const att = setup(uploadImage);
    att.handleFileInputChange(inputEvent([imageFile('gone.png')]));
    att.removeAttachment(att.attachments.value[0].localId);
    unmountLast();

    resolveUpload({ fileId: 'f_gone', name: 'gone.png', mediaType: 'image/png' });
    await flushUploads();

    expect(storedDraft('sess-1')).toBeNull();
    const remounted = setup(undefined);
    expect(remounted.attachments.value).toHaveLength(0);
  });

  it('drops a restored in-flight chip when the upload fails after the remount', async () => {
    // The remount restored the still-in-flight upload as an uploading chip —
    // when the upload then fails, the module-level settle's drop path must
    // take that chip down (it would spin forever otherwise).
    let resolveUpload: (value: null) => void = () => {};
    const uploadImage = vi.fn<UploadImage>().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpload = resolve;
        }),
    );
    const first = setup(uploadImage);
    first.handleFileInputChange(inputEvent([imageFile('late.png')]));
    unmountLast();

    const remounted = setup(undefined);
    expect(remounted.attachments.value).toHaveLength(1);
    expect(remounted.attachments.value[0]).toMatchObject({ name: 'late.png', uploading: true });

    resolveUpload(null);
    await flushUploads();

    expect(remounted.attachments.value).toHaveLength(0);
    expect(storedDraft('sess-1')).toBeNull();
  });

  it('keeps the originating instance’s own chip (marked as error) when its upload fails', async () => {
    // The drop path only touches chips restored from the registry — a live
    // instance's OWN failed upload keeps its chip, marked as an error by its
    // completion handler.
    const uploadImage = vi.fn<UploadImage>().mockResolvedValue(null);
    const att = setup(uploadImage);
    att.handleFileInputChange(inputEvent([imageFile('bad.png')]));

    await flushUploads();

    expect(att.attachments.value).toHaveLength(1);
    expect(att.attachments.value[0]).toMatchObject({ name: 'bad.png', uploading: false, error: true });
    expect(storedDraft('sess-1')).toBeNull();
  });

  it('delivers a settle to a session’s in-memory cache when no live composer shows it', async () => {
    // Session A hydrated once (so a live instance holds an in-memory cache for
    // it), the user moved to session B, and only THEN does an upload started
    // in A (by a since-unmounted composer) settle. The cache — which hydrate
    // prefers over storage — must get the entry too, or switching back to A
    // would show a stale strip for the rest of the page's life.
    let resolveUpload: (value: { fileId: string; name: string; mediaType: string }) => void = () => {};
    const uploadImage = vi.fn<UploadImage>().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpload = resolve;
        }),
    );
    const uploader = setup(uploadImage);
    uploader.handleFileInputChange(inputEvent([imageFile('late.png')]));
    unmountLast();

    // Seed a ready attachment into session A's stored draft.
    const seedUpload = vi.fn<UploadImage>().mockResolvedValue({ fileId: 'f_seed', name: 'seed.png', mediaType: 'image/png' });
    const seeder = setup(seedUpload);
    seeder.handleFileInputChange(inputEvent([imageFile('seed.png')]));
    await flushUploads();
    unmountLast();

    // A live instance visits session A (hydrates seed.png into its cache —
    // and restores the still-in-flight late.png as an uploading chip), then
    // switches to session B.
    const sid = ref<string | undefined>('sess-1');
    const inst = useAttachmentUpload({
      api: apiMock,
      uploadImage: () => undefined,
      sessionId: () => sid.value,
    });
    expect(inst.attachments.value).toHaveLength(2);
    sid.value = 'sess-2';
    await nextTick();
    expect(inst.attachments.value).toHaveLength(0);

    // The upload started in session A settles now — no live composer shows A.
    resolveUpload({ fileId: 'f_late', name: 'late.png', mediaType: 'image/png' });
    await flushUploads();

    // Switching back to A: hydrate skips (the cache exists), and the strip
    // shows BOTH attachments in ADD order (late.png was attached first) —
    // the seeded one and the late-settled one, ready to send.
    sid.value = 'sess-1';
    await nextTick();
    expect(inst.attachments.value).toHaveLength(2);
    expect(inst.attachments.value.map((a) => a.fileId)).toEqual(['f_late', 'f_seed']);
    expect(inst.attachments.value.every((a) => !a.uploading)).toBe(true);
  });

  it('revokes the object URL and closes the preview of a chip a failed URL-refill re-upload drops', async () => {
    // The re-upload failure path drops the chip from the strip — its object
    // URL must be revoked (the unmount hook can only revoke URLs of chips
    // still in the array) and an open preview on it must close, same as the
    // manual remove path.
    const restoreFetch = stubUrlFetch();
    try {
      const uploadImage = vi.fn<UploadImage>().mockResolvedValue(null);
      const att = setup(uploadImage);
      att.loadAttachments([
        { kind: 'image', url: 'blob:refill-url', name: 'refill.png' } as TurnAttachment,
      ]);
      const chip = att.attachments.value[0];
      expect(chip).toMatchObject({ uploading: true, previewUrl: 'blob:refill-url' });
      att.openAttachmentPreview(chip);

      await flushUploads();

      expect(att.attachments.value).toHaveLength(0);
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:refill-url');
      expect(att.previewAttachment.value).toBeNull();
      expect(storedDraft('sess-1')).toBeNull();
    } finally {
      restoreFetch();
    }
  });
});
