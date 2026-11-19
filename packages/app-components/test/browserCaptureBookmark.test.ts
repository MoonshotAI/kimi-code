import type { BrowserCapture } from '@moonshot-ai/app-core/browser-reference';
import { describe, expect, it, vi } from 'vitest';
import type { ComposerEditorApi } from '@moonshot-ai/app-composer/runtime';
import { removedBrowserCaptureBindings, restoreBrowserCaptureBookmark } from '../src/composer/browserReferences';

function editor(restored: boolean, connected = true) {
  const methods = { dom: { isConnected: connected }, restoreSelectionBookmark: vi.fn(() => restored), getText: () => 'Existing text', setSelectionRange: vi.fn() };
  return { methods, api: methods as unknown as ComposerEditorApi };
}

describe('browser capture insertion bookmark', () => {
  it('keeps the mapped insertion point when the bookmark can be restored', () => {
    const { methods, api } = editor(true);
    expect(restoreBrowserCaptureBookmark(api, 'bookmark', new AbortController().signal)).toBe(true);
    expect(methods.restoreSelectionBookmark).toHaveBeenCalledWith('bookmark');
    expect(methods.setSelectionRange).not.toHaveBeenCalled();
  });

  it('appends after existing text when a same-scope bookmark no longer resolves', () => {
    const { methods, api } = editor(false);
    expect(restoreBrowserCaptureBookmark(api, 'missing', new AbortController().signal)).toBe(true);
    expect(methods.setSelectionRange).toHaveBeenCalledWith(13, 13);
  });

  it('does not touch selection after cancellation or editor disposal', () => {
    const { methods, api } = editor(true);
    const cancelled = new AbortController();
    cancelled.abort();
    expect(restoreBrowserCaptureBookmark(api, 'bookmark', cancelled.signal)).toBe(false);
    expect(methods.restoreSelectionBookmark).not.toHaveBeenCalled();
    const gone = editor(false, false);
    expect(restoreBrowserCaptureBookmark(gone.api, 'bookmark', new AbortController().signal)).toBe(false);
    expect(gone.methods.setSelectionRange).not.toHaveBeenCalled();
  });
});

it('keeps a shared native marker until its final local capture is removed', () => {
  const first = { id: 'first', bindingId: 'native' } as BrowserCapture;
  const second = { id: 'second', bindingId: 'native' } as BrowserCapture;
  expect(removedBrowserCaptureBindings([first, second], [second])).toEqual([]);
  expect(removedBrowserCaptureBindings([first, second], [])).toEqual([second]);
});
