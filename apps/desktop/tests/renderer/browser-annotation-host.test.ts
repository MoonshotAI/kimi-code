import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComposerEditorApi } from '@moonshot-ai/app-composer/runtime';
import type { BrowserReferenceComposerTarget } from '@moonshot-ai/app-components';
import type { BrowserCapture } from '@moonshot-ai/app-core/browser-reference';

const dialogs = vi.hoisted(() => ({
  handlers: null as null | { onConfirm(value?: string): void; onAuxiliary(value?: string): void; onCancel(): void },
  show: vi.fn(), dispose: vi.fn(), release: vi.fn(),
}));

vi.mock('@moonshot-ai/app-ui', () => ({ registerExternalMenuSurface: () => dialogs.release }));
vi.mock('../../src/renderer/lib/browserOverlayDialog', () => ({ registerBrowserOverlayDialog: (handlers: NonNullable<typeof dialogs.handlers>) => { dialogs.handlers = handlers; return { available: true, show: dialogs.show, dispose: dialogs.dispose }; } }));

import { createBrowserAnnotationHost } from '../../src/renderer/lib/browserAnnotationHost';

const capture: BrowserCapture = {
  version: 1, id: 'capture-example', label: 'Save button', ordinal: 1, capturedAt: '2026-09-07T00:00:00.000Z',
  page: { title: 'Example', url: 'https://example.test' },
  target: { kind: 'element', tagName: 'button', bounds: { x: 10, y: 10, width: 100, height: 30 } },
  viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0, zoomFactor: 1, devicePixelRatio: 1 },
};
const reference = { id: 'ref-example', captureId: capture.id, comment: 'Original comment' };

beforeEach(() => {
  vi.clearAllMocks();
  dialogs.handlers = null;
  vi.stubGlobal('document', { activeElement: null, documentElement: {} });
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
  vi.stubGlobal('window', { localStorage: { length: 0 }, matchMedia: () => ({ matches: false }), kimiDesktop: { browserCollectAnnotationAssets: vi.fn(async () => {}), browserPickAnnotation: vi.fn(), browserCancelAnnotationPick: vi.fn(), browserReadAnnotationAsset: vi.fn(), browserCompleteAnnotationCapture: vi.fn(async () => {}), browserShowAnnotation: vi.fn(), browserHideAnnotation: vi.fn() } });
});
afterEach(() => vi.unstubAllGlobals());

function host(notify = vi.fn()) {
  return createBrowserAnnotationHost({ context: () => 'session-a', revealBrowser: () => false, t: (key) => key, notify })!;
}

describe('browser annotation screenshot recovery controls', () => {
  it('shows the screenshot failure and retries without discarding the edited comment', async () => {
    const editorHost = host();
    const result = editorHost.edit(reference, capture, undefined, false, 'failed');
    expect(dialogs.show).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('browserReference.screenshotFailed'), auxiliary: { label: 'browserReference.retryScreenshot' } }));
    dialogs.handlers!.onAuxiliary('Changed comment');
    await expect(result).resolves.toEqual({ comment: 'Changed comment', locate: false, retryScreenshot: true });
    expect(reference.comment).toBe('Original comment');
    expect(dialogs.release).toHaveBeenCalledOnce();
    editorHost.dispose();
  });

  it('keeps uploading status informative and read-only references free of upload actions', async () => {
    const editorHost = host();
    const uploading = editorHost.edit(reference, capture, undefined, false, 'uploading');
    expect(dialogs.show.mock.lastCall?.[0]).toMatchObject({ message: expect.stringContaining('browserReference.screenshotUploading'), auxiliary: { label: 'browserReference.saveAndLocate' } });
    dialogs.handlers!.onConfirm('Saved');
    await expect(uploading).resolves.toEqual({ comment: 'Saved', locate: false });
    const readOnly = editorHost.edit(reference, capture, undefined, true, 'failed');
    expect(dialogs.show.mock.lastCall?.[0]).toMatchObject({ input: { readOnly: true }, auxiliary: { label: 'browserReference.locate' } });
    expect(dialogs.show.mock.lastCall?.[0].message ?? '').not.toContain('browserReference.screenshotFailed');
    dialogs.handlers!.onAuxiliary();
    await expect(readOnly).resolves.toEqual({ comment: 'Original comment', locate: true, retryScreenshot: false });
    editorHost.dispose();
  });

  it('ignores a late retry action after the originating scope cancels the dialog', async () => {
    const editorHost = host();
    const result = editorHost.edit(reference, capture, undefined, false, 'failed');
    editorHost.cancelAll();
    dialogs.handlers!.onAuxiliary('Late comment');
    await expect(result).resolves.toBeNull();
    expect(dialogs.dispose).toHaveBeenCalledOnce();
    expect(dialogs.release).toHaveBeenCalledOnce();
    editorHost.dispose();
  });
});

class EditorElement extends EventTarget {
  isConnected = true;
  visible = true;
  disabled = false;
  contains(value: unknown) { return value === this; }
  getClientRects() { return this.visible ? [{}] : []; }
  getAttribute(name: string) { return name === 'aria-disabled' && this.disabled ? 'true' : null; }
}

function target(name: string) {
  const dom = new EditorElement();
  const api = { dom, saveSelectionBookmark: vi.fn(() => name), discardSelectionBookmark: vi.fn(), getBrowserReferenceData: () => ({ captures: [], references: [] }) } as unknown as ComposerEditorApi;
  const accept = vi.fn<BrowserReferenceComposerTarget['accept']>(async () => true);
  return { dom, api, accept, value: { editor: () => api, accept } };
}

function picker() {
  const bridge = (window as unknown as { kimiDesktop: { browserPickAnnotation: ReturnType<typeof vi.fn>; browserCompleteAnnotationCapture: ReturnType<typeof vi.fn>; browserShowAnnotation: ReturnType<typeof vi.fn>; browserHideAnnotation: ReturnType<typeof vi.fn> } }).kimiDesktop;
  bridge.browserPickAnnotation.mockResolvedValue({ capture });
  bridge.browserShowAnnotation.mockResolvedValue({ located: true });
  return bridge;
}

describe('browser capture origin', () => {
  it('uses the last focused visible composer rather than the last registered one', async () => {
    const bridge = picker();
    const editorHost = host();
    const main = target('main');
    const side = target('side');
    editorHost.registerTarget(main.value);
    editorHost.registerTarget(side.value);
    main.dom.dispatchEvent(new Event('focusin'));
    const picking = editorHost.beginPick('page');
    await vi.waitFor(() => expect(dialogs.handlers).not.toBeNull());
    expect(bridge.browserShowAnnotation).toHaveBeenCalledWith(capture.id, capture.ordinal, false);
    expect(dialogs.show.mock.calls[0]?.[0]).not.toHaveProperty('preview');
    dialogs.handlers!.onConfirm('Comment');
    await picking;
    expect(main.accept).toHaveBeenCalledOnce();
    expect(side.accept).not.toHaveBeenCalled();
    editorHost.dispose();
  });

  it.each(['hidden', 'disabled'])('does not select a previously focused %s composer', async (mode) => {
    picker();
    const editorHost = host();
    const first = target('first');
    const second = target('second');
    editorHost.registerTarget(first.value);
    editorHost.registerTarget(second.value);
    first.dom.dispatchEvent(new Event('focusin'));
    if (mode === 'hidden') first.dom.visible = false;
    else first.dom.disabled = true;
    const picking = editorHost.beginPick('page');
    await vi.waitFor(() => expect(dialogs.handlers).not.toBeNull());
    dialogs.handlers!.onConfirm();
    await picking;
    expect(second.accept).toHaveBeenCalledOnce();
    expect(first.accept).not.toHaveBeenCalled();
    editorHost.dispose();
  });

  it('cancels the pending acceptance when the originating editor is removed', async () => {
    const bridge = picker();
    const notify = vi.fn();
    const editorHost = host(notify);
    const origin = target('origin');
    let fail!: (error: Error) => void;
    origin.accept.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    const unregister = editorHost.registerTarget(origin.value);
    const picking = editorHost.beginPick('page');
    await vi.waitFor(() => expect(dialogs.handlers).not.toBeNull());
    dialogs.handlers!.onConfirm();
    await vi.waitFor(() => expect(origin.accept).toHaveBeenCalledOnce());
    const signal = origin.accept.mock.calls[0]![3];
    unregister();
    expect(signal.aborted).toBe(true);
    fail(new Error('Late asset read error'));
    await picking;
    expect(bridge.browserShowAnnotation).toHaveBeenCalledOnce();
    expect(notify).not.toHaveBeenCalled();
    expect(bridge.browserHideAnnotation).toHaveBeenCalledWith(capture.id);
    expect(bridge.browserCompleteAnnotationCapture).toHaveBeenCalledWith(capture.id, 'cancel');
    editorHost.dispose();
  });

  it('does not reopen the comment dialog after cancelling an awaited context-menu highlight', async () => {
    const bridge = picker();
    let finish!: (result: { located: boolean }) => void;
    bridge.browserShowAnnotation.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const editorHost = host();
    editorHost.registerTarget(target('origin').value);
    const picking = editorHost.beginPick('page', 'context-target');
    await vi.waitFor(() => expect(bridge.browserShowAnnotation).toHaveBeenCalledOnce());
    editorHost.cancelAll();
    finish({ located: true });
    await picking;
    expect(dialogs.show).not.toHaveBeenCalled();
    editorHost.dispose();
  });
});

it('locates and hides remapped captures through their original native binding', async () => {
  const bridge = picker();
  const editorHost = host();
  const copy = { ...capture, id: 'local-copy', bindingId: 'original-capture' };
  await expect(editorHost.locate(copy)).resolves.toBe(true);
  expect(bridge.browserShowAnnotation).toHaveBeenCalledWith('original-capture', capture.ordinal, true);
  const editor = target('copy').api;
  editorHost.syncMarkers(editor, [copy]);
  editorHost.syncMarkers(editor, []);
  expect(bridge.browserHideAnnotation).toHaveBeenCalledWith('original-capture');
  editorHost.dispose();
});

it('retains an accepted capture and releases a cancelled capture', async () => {
  const bridge = picker();
  const editorHost = host();
  editorHost.registerTarget(target('origin').value);
  const accepted = editorHost.beginPick('page');
  await vi.waitFor(() => expect(dialogs.handlers).not.toBeNull());
  dialogs.handlers!.onConfirm('Keep');
  await accepted;
  expect(bridge.browserCompleteAnnotationCapture).toHaveBeenLastCalledWith(capture.id, 'commit');
  dialogs.handlers = null;
  const cancelled = editorHost.beginPick('page');
  await vi.waitFor(() => expect(dialogs.handlers).not.toBeNull());
  dialogs.handlers!.onCancel();
  await cancelled;
  expect(bridge.browserCompleteAnnotationCapture).toHaveBeenLastCalledWith(capture.id, 'cancel');
  editorHost.dispose();
});

it('does not insert a reference before its screenshot promotion succeeds', async () => {
  const bridge = picker();
  let promote!: () => void;
  bridge.browserCompleteAnnotationCapture.mockImplementation((_id: string, action: string) => action === 'prepare' ? new Promise<void>((done) => { promote = done; }) : Promise.resolve());
  const editorHost = host();
  const editor = target('origin');
  editorHost.registerTarget(editor.value);
  const picking = editorHost.beginPick('page');
  await vi.waitFor(() => expect(dialogs.handlers).not.toBeNull());
  dialogs.handlers!.onConfirm('Keep');
  await vi.waitFor(() => expect(bridge.browserCompleteAnnotationCapture).toHaveBeenCalledWith(capture.id, 'prepare'));
  expect(editor.accept).not.toHaveBeenCalled();
  editorHost.cancelAll();
  promote();
  await picking;
  expect(editor.accept).not.toHaveBeenCalled();
  editorHost.dispose();
});

it('restores markers on undo and hides only after all composers release a binding', () => {
  const bridge = picker();
  const editorHost = host();
  const first = target('first');
  const second = target('second');
  editorHost.registerTarget(first.value);
  const releaseSecond = editorHost.registerTarget(second.value);
  const copy = { ...capture, id: 'copy', bindingId: capture.id };
  editorHost.syncMarkers(first.api, [capture]);
  expect(bridge.browserShowAnnotation).toHaveBeenCalledWith(capture.id, capture.ordinal, false);
  editorHost.syncMarkers(second.api, [copy]);
  editorHost.syncMarkers(first.api, []);
  expect(bridge.browserHideAnnotation).not.toHaveBeenCalled();
  releaseSecond();
  expect(bridge.browserHideAnnotation).toHaveBeenCalledOnce();
  bridge.browserShowAnnotation.mockClear();
  editorHost.syncMarkers(first.api, [capture]);
  expect(bridge.browserShowAnnotation).toHaveBeenCalledWith(capture.id, capture.ordinal, false);
  editorHost.dispose();
});
