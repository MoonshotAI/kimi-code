import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAttachmentUpload } from '../../src/renderer/composables/useAttachmentUpload';

// attachment_added tracking: `via` comes from the entry handler and `kind`
// from the file's MIME bucket. Only the exported handlers are exercised here
// (the paste listener registers on `document`, which the node test
// environment has no equivalent of); the drop and click paths share the same
// one-line track call inside addFiles.
const globalRef = globalThis as { window?: unknown };
const originalWindow = globalRef.window;

afterEach(() => {
  if (originalWindow === undefined) delete globalRef.window;
  else globalRef.window = originalWindow;
});

function trackSpy() {
  const spy = vi.fn<(event: string, properties?: Record<string, unknown>) => void>();
  globalRef.window = { kimiDesktop: { track: spy } };
  return spy;
}

const uploadOk = async () => ({ fileId: 'file_1', name: 'n', mediaType: 'application/octet-stream' });

function makeUpload(enabled = true) {
  return useAttachmentUpload({
    uploadImage: () => (enabled ? uploadOk : undefined),
    sessionId: () => 'sess_1',
  });
}

function inputEvent(files: File[]): Event {
  return { target: { files, value: '' } } as unknown as Event;
}

function dropEvent(files: File[]): DragEvent {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    dataTransfer: { files },
  } as unknown as DragEvent;
}

describe('attachment_added tracking', () => {
  it('tracks each picked file as via click with its MIME-derived kind', () => {
    const spy = trackSpy();
    const up = makeUpload();
    up.handleFileInputChange(
      inputEvent([
        new File(['x'], 'shot.png', { type: 'image/png' }),
        new File(['x'], 'notes.pdf', { type: 'application/pdf' }),
      ]),
    );
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenNthCalledWith(1, 'attachment_added', { via: 'click', kind: 'image' });
    expect(spy).toHaveBeenNthCalledWith(2, 'attachment_added', { via: 'click', kind: 'file' });
  });

  it('tracks a composer drop as via drop', () => {
    const spy = trackSpy();
    const up = makeUpload();
    up.handleDrop(dropEvent([new File(['x'], 'clip.mp4', { type: 'video/mp4' })]));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('attachment_added', { via: 'drop', kind: 'video' });
  });

  it('tracks nothing when attaching is disabled (no upload dep)', () => {
    const spy = trackSpy();
    const up = makeUpload(false);
    up.handleFileInputChange(inputEvent([new File(['x'], 'shot.png', { type: 'image/png' })]));
    up.handleDrop(dropEvent([new File(['x'], 'shot.png', { type: 'image/png' })]));
    expect(spy).not.toHaveBeenCalled();
  });
});
