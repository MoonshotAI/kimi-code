import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseDraftAttachmentEntry, serializableAttachmentEntry, type AttachmentEntry } from '@moonshot-ai/app-composer/features/attachment';
import { ComposerAttachmentStore } from '../src/lib/composerAttachmentStore';
import { BrowserScreenshotRecovery, browserScreenshotFile, type BrowserScreenshotAsset } from '../src/lib/browserScreenshotRecovery';

const stores: ComposerAttachmentStore[] = [];
const asset: BrowserScreenshotAsset = { data: btoa('PNG bytes'), size: 9, mimeType: 'image/png', name: 'owned.png' };

function setup(patch: Partial<AttachmentEntry> = {}) {
  const store = new ComposerAttachmentStore();
  stores.push(store);
  const entry = parseDraftAttachmentEntry({ attId: 'shot', key: 'blob:shot', kind: 'image', name: 'capture.png', purpose: 'browser-screenshot', browserAssetId: 'asset-example', uploading: true, refCount: 0, ...patch })!;
  store.load('session-a', [entry]);
  const recovery = new BrowserScreenshotRecovery(store);
  const readAsset = vi.fn(async () => asset);
  const upload = vi.fn();
  const options = { scope: 'session-a', attId: entry.attId, readAsset, upload, patch: (value: Partial<AttachmentEntry>) => { store.patch('session-a', entry.attId, value); } };
  return { store, entry, recovery, readAsset, upload, options };
}

afterEach(() => { for (const store of stores.splice(0)) { store.clear('session-a'); store.clear('session-b'); } });

describe('durable browser screenshot recovery', () => {
  it('recovers a persisted interrupted screenshot without changing its reference identity', async () => {
    const { store, entry, recovery, options, readAsset, upload } = setup();
    expect(entry.error).toBe('upload-interrupted');
    expect(store.source('session-a', 'shot')).toBeUndefined();
    await expect(recovery.recover(options)).resolves.toBe(true);
    expect(readAsset).toHaveBeenCalledExactlyOnceWith('asset-example');
    const blob = upload.mock.calls[0]![0] as Blob;
    expect(await blob.text()).toBe('PNG bytes');
    expect(upload.mock.calls[0]![1]).toBe('capture.png');
    expect(store.entry('session-a', 'shot')).toMatchObject({ attId: 'shot', key: 'blob:shot', browserAssetId: 'asset-example', purpose: 'browser-screenshot', uploading: true, error: undefined, size: 9 });
    expect(store.entry('session-a', 'shot')?.previewUrl).toMatch(/^blob:/);
  });

  it('deduplicates recovery reads and hands ownership to the new upload task', async () => {
    const { store, recovery, options, readAsset, upload } = setup();
    let resolve!: (asset: BrowserScreenshotAsset) => void;
    readAsset.mockImplementation(() => new Promise((done) => { resolve = done; }));
    upload.mockImplementation(() => store.beginUpload('session-a', 'shot'));
    const first = recovery.recover(options);
    await expect(recovery.recover(options)).resolves.toBe(false);
    resolve(asset);
    await expect(first).resolves.toBe(true);
    expect(readAsset).toHaveBeenCalledOnce();
    expect(store.uploadRunning('session-a', 'shot')).toBe(true);
  });

  it('does not resurrect a deleted reference and allows recovery when it is reactivated', async () => {
    const { store, recovery, options, readAsset, upload } = setup();
    let resolve!: (asset: BrowserScreenshotAsset) => void;
    readAsset.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const first = recovery.recover(options);
    store.abortUpload('session-a', 'shot');
    resolve(asset);
    await expect(first).resolves.toBe(false);
    expect(upload).not.toHaveBeenCalled();
    await expect(recovery.recover(options)).resolves.toBe(true);
    expect(upload).toHaveBeenCalledOnce();
  });

  it('can recover immediately on undo before the cancelled disk read settles', async () => {
    const { store, recovery, options, readAsset, upload } = setup();
    let finishOld!: (asset: BrowserScreenshotAsset) => void;
    readAsset.mockImplementationOnce(() => new Promise((done) => { finishOld = done; }));
    const old = recovery.recover(options);
    store.abortUpload('session-a', 'shot');
    await expect(recovery.recover(options)).resolves.toBe(true);
    finishOld(asset);
    await expect(old).resolves.toBe(false);
    expect(readAsset).toHaveBeenCalledTimes(2);
    expect(upload).toHaveBeenCalledOnce();
  });

  it('does not update a different resource that reused the same attachment id', async () => {
    const { store, recovery, options, readAsset, upload } = setup();
    let resolve!: (asset: BrowserScreenshotAsset) => void;
    readAsset.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const first = recovery.recover(options);
    store.load('session-a', [{ ...store.entry('session-a', 'shot')!, key: 'blob:other', browserAssetId: 'other-asset' }]);
    resolve(asset);
    await expect(first).resolves.toBe(false);
    expect(upload).not.toHaveBeenCalled();
    expect(store.entry('session-a', 'shot')?.key).toBe('blob:other');
    expect(store.source('session-a', 'shot')).toBeUndefined();
  });

  it('retains failure state without a retry loop and supports an explicit retry', async () => {
    const { store, recovery, options, readAsset, upload } = setup();
    readAsset.mockRejectedValueOnce(new Error('temporarily unavailable'));
    await expect(recovery.recover(options)).resolves.toBe(false);
    expect(store.entry('session-a', 'shot')).toMatchObject({ uploading: false, error: 'upload-interrupted' });
    expect(store.uploadRunning('session-a', 'shot')).toBe(false);
    await expect(recovery.recover(options)).resolves.toBe(false);
    expect(readAsset).toHaveBeenCalledOnce();
    await expect(recovery.recover({ ...options, retry: true })).resolves.toBe(true);
    expect(upload).toHaveBeenCalledOnce();
  });

  it('reuses the cached source and keeps another session with the same attachment id untouched', async () => {
    const { store, entry, recovery, options, readAsset } = setup();
    const cached = new Blob(['cached'], { type: 'image/png' });
    store.setSource('session-a', 'shot', cached);
    store.load('session-b', [{ ...entry, browserAssetId: 'other-asset' }]);
    await expect(recovery.recover({ ...options, readAsset: undefined })).resolves.toBe(true);
    expect(readAsset).not.toHaveBeenCalled();
    expect(store.source('session-b', 'shot')).toBeUndefined();
    expect(store.entry('session-b', 'shot')?.error).toBe('upload-interrupted');
  });

  it('retries a failed resource with an old file id only after recovering its source', async () => {
    const { store, recovery, options, readAsset, upload } = setup({ fileId: 'old-file', error: 'upload-failed', uploading: false });
    readAsset.mockRejectedValueOnce(new Error('not readable yet'));
    await expect(recovery.recover({ ...options, retry: true })).resolves.toBe(false);
    expect(store.entry('session-a', 'shot')?.fileId).toBe('old-file');
    await expect(recovery.recover({ ...options, retry: true })).resolves.toBe(true);
    expect(store.entry('session-a', 'shot')?.fileId).toBeUndefined();
    expect(upload).toHaveBeenCalledOnce();
  });

  it('does not reupload ready images or adopt ordinary attachments', async () => {
    for (const patch of [{ fileId: 'ready-file' }, { purpose: undefined }, { browserAssetId: undefined }]) {
      const { recovery, options, readAsset } = setup(patch);
      await expect(recovery.recover(options)).resolves.toBe(false);
      expect(readAsset).not.toHaveBeenCalled();
    }
  });

  it('validates the asset size and type before creating a source file', () => {
    expect(() => browserScreenshotFile({ ...asset, size: 2 })).toThrow('size');
    expect(() => browserScreenshotFile({ ...asset, mimeType: 'text/html' })).toThrow('screenshot');
    expect(() => browserScreenshotFile({ ...asset, data: '', size: 0 })).toThrow('size');
  });
});

it('retries a known remote screenshot without a native bridge or local blob', async () => {
  const { store, recovery, options, upload } = setup({ browserAssetId: undefined });
  store.setRemoteSource('session-a', 'shot', { sessionId: 'original-session', fileId: 'original-image' });
  const readRemote = vi.fn(async () => new Blob(['remote screenshot'], { type: 'image/png' }));
  const sources = { readAsset: undefined, readRemote };
  expect(recovery.canRecover('session-a', 'shot', sources)).toBe(true);
  readRemote.mockRejectedValueOnce(new Error('Offline'));
  expect(await recovery.recover({ ...options, ...sources })).toBe(false);
  expect(await recovery.recover({ ...options, ...sources, retry: true })).toBe(true);
  expect(readRemote).toHaveBeenCalledWith({ sessionId: 'original-session', fileId: 'original-image' }, expect.any(AbortSignal));
  expect(await (upload.mock.calls[0]![0] as Blob).text()).toBe('remote screenshot');
});

it('does not apply a remote screenshot after its draft resource is released', async () => {
  const { store, recovery, options, upload } = setup({ browserAssetId: undefined });
  store.setRemoteSource('session-a', 'shot', { sessionId: 'original-session', fileId: 'original-image' });
  let finish!: (blob: Blob) => void;
  const pending = recovery.recover({ ...options, readAsset: undefined, readRemote: () => new Promise((done) => { finish = done; }) });
  store.abortUpload('session-a', 'shot');
  finish(new Blob(['late']));
  expect(await pending).toBe(false);
  expect(upload).not.toHaveBeenCalled();
});

it('retains remote recovery through serialization and a fresh attachment store', async () => {
  const { store } = setup({ browserAssetId: undefined });
  store.setRemoteSource('session-a', 'shot', { sessionId: 'original-session', fileId: 'original-image.png' });
  const persisted = JSON.parse(JSON.stringify(serializableAttachmentEntry(store.entry('session-a', 'shot')!)));
  const fresh = new ComposerAttachmentStore();
  stores.push(fresh);
  fresh.load('session-a', [parseDraftAttachmentEntry(persisted)!]);
  const recovery = new BrowserScreenshotRecovery(fresh);
  const readRemote = vi.fn(async () => new Blob(['restored'], { type: 'image/png' }));
  const upload = vi.fn();
  expect(recovery.canRecover('session-a', 'shot', { readRemote })).toBe(true);
  expect(await recovery.recover({ scope: 'session-a', attId: 'shot', readRemote, upload, patch: (value) => fresh.patch('session-a', 'shot', value) })).toBe(true);
  expect(readRemote).toHaveBeenCalledWith({ sessionId: 'original-session', fileId: 'original-image.png' }, expect.any(AbortSignal));
  expect(upload).toHaveBeenCalledOnce();
  expect(parseDraftAttachmentEntry({ ...persisted, remoteSource: { sessionId: '../outside', fileId: 'file' } })?.remoteSource).toBeUndefined();
});
