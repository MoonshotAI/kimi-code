import { onScopeDispose, shallowRef, watch } from 'vue';
import { parseAttachmentThumbnailUrl } from '@moonshot-ai/app-composer/features/attachment';
import { parseBrowserCapture, type BrowserCapture, type BrowserReference } from '@moonshot-ai/app-core/browser-reference';
import type { BrowserReferenceEditResult, BrowserReferenceScreenshotState } from './browserReferences';

export interface BrowserReferenceDetailsState {
  id: number;
  reference: BrowserReference;
  capture: BrowserCapture;
  thumbnail?: string;
  readOnly: boolean;
  screenshotState?: BrowserReferenceScreenshotState;
  canRetry: boolean;
}

export function useBrowserReferenceDetails(scope: () => string) {
  const state = shallowRef<BrowserReferenceDetailsState | null>(null);
  let nextId = 0;
  let resolve: ((result: BrowserReferenceEditResult | null) => void) | null = null;

  function finish(id: number, result: BrowserReferenceEditResult | null): void {
    const current = state.value;
    if (current === null || current.id !== id) return;
    const done = resolve;
    resolve = null;
    state.value = null;
    done?.(current.readOnly || result === null ? null : { comment: result.comment, locate: false, retryScreenshot: current.canRetry && result.retryScreenshot === true, includeScreenshot: current.capture.target.kind === 'region' ? true : result.includeScreenshot ?? current.reference.includeScreenshot });
  }

  function close(): void {
    if (state.value !== null) finish(state.value.id, null);
  }

  function open(input: Omit<BrowserReferenceDetailsState, 'id' | 'readOnly' | 'canRetry'> & { readOnly?: boolean; canRetry?: boolean }): Promise<BrowserReferenceEditResult | null> {
    close();
    const capture = parseBrowserCapture(input.capture);
    if (capture === null) return Promise.resolve(null);
    state.value = { ...input, thumbnail: parseAttachmentThumbnailUrl(input.thumbnail), capture, reference: { ...input.reference }, id: ++nextId, readOnly: input.readOnly === true, canRetry: input.canRetry === true };
    return new Promise((done) => { resolve = done; });
  }

  watch(scope, close, { flush: 'sync' });
  onScopeDispose(close);
  return { state, open, finish, close };
}
