import { describe, expect, it } from 'vitest';
import { effectScope, ref } from 'vue';
import type { BrowserCapture } from '@moonshot-ai/app-core/browser-reference';
import { useBrowserReferenceDetails } from '../src/composer/browserReferenceDetails';

function input() {
  const capture: BrowserCapture = {
    version: 1, id: 'capture-example', ordinal: 1, label: 'Save button', capturedAt: '2026-09-07T00:00:00.000Z',
    page: { url: 'https://example.test', title: 'Example' },
    target: { kind: 'element', tagName: 'button', bounds: { x: 10, y: 10, width: 80, height: 30 } },
    viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0, zoomFactor: 1, devicePixelRatio: 1 },
  };
  return { capture, reference: { id: 'ref-example', captureId: capture.id, comment: 'Original' }, thumbnail: 'data:image/png;base64,AA==' };
}

function setup() {
  const scope = effectScope();
  const session = ref('session-a');
  const details = scope.run(() => useBrowserReferenceDetails(() => session.value))!;
  return { scope, session, details };
}

describe('browser reference details without a native host', () => {
  it('opens a detached snapshot and applies only the edited comment', async () => {
    const { scope, details } = setup();
    const original = input();
    const pending = details.open(original);
    original.reference.comment = 'External mutation';
    original.capture.page.title = 'Changed page';
    expect(details.state.value?.reference.comment).toBe('Original');
    expect(details.state.value?.capture.page.title).toBe('Example');
    details.finish(details.state.value!.id, { comment: 'Edited', locate: true, retryScreenshot: true });
    await expect(pending).resolves.toEqual({ comment: 'Edited', locate: false, retryScreenshot: false });
    expect(details.state.value).toBeNull();
    scope.stop();
  });

  it('does not automatically load external or executable thumbnail sources', async () => {
    const { scope, details } = setup();
    const pending = details.open({ ...input(), thumbnail: 'https://example.test/track.png' });
    expect(details.state.value?.thumbnail).toBeUndefined();
    details.close();
    await expect(pending).resolves.toBeNull();
    const second = details.open({ ...input(), thumbnail: 'data:image/svg+xml,<svg onload="bad()"/>' });
    expect(details.state.value?.thumbnail).toBeUndefined();
    details.close();
    await expect(second).resolves.toBeNull();
    scope.stop();
  });

  it('keeps historical references read-only even if an edit result is emitted', async () => {
    const { scope, details } = setup();
    const pending = details.open({ ...input(), readOnly: true, canRetry: true });
    details.finish(details.state.value!.id, { comment: 'Attempted edit', locate: false, retryScreenshot: true });
    await expect(pending).resolves.toBeNull();
    scope.stop();
  });

  it('cancels on a scope switch or disposal and ignores late completion', async () => {
    const { scope, session, details } = setup();
    const pending = details.open(input());
    const id = details.state.value!.id;
    session.value = 'session-b';
    details.finish(id, { comment: 'Late', locate: false });
    await expect(pending).resolves.toBeNull();
    const next = details.open(input());
    scope.stop();
    await expect(next).resolves.toBeNull();
  });

  it('does not let the previous dialog resolve its replacement', async () => {
    const { scope, details } = setup();
    const first = details.open(input());
    const oldId = details.state.value!.id;
    const second = details.open({ ...input(), canRetry: true });
    await expect(first).resolves.toBeNull();
    details.finish(oldId, { comment: 'Stale', locate: false });
    expect(details.state.value).not.toBeNull();
    details.finish(details.state.value!.id, { comment: 'Retry with comment', locate: false, retryScreenshot: true });
    await expect(second).resolves.toEqual({ comment: 'Retry with comment', locate: false, retryScreenshot: true });
    scope.stop();
  });
});
