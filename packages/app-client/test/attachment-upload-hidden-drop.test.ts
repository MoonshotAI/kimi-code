// @vitest-environment jsdom
import { createApp, h, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAttachmentUpload } from '../src/composables/useAttachmentUpload';

const apiMock = {
  getFileBlob: vi.fn(),
  getSessionMediaBlob: vi.fn(),
  getFileUrl: vi.fn((fileId: string) => `https://example.test/api/v1/files/${fileId}`),
  getSessionMediaUrl: vi.fn(
    (sessionId: string, fileId: string) => `https://example.test/api/v1/sessions/${sessionId}/media/${fileId}`,
  ),
};

let app: App | null = null;
let host: HTMLDivElement;

function mountUpload(visible: () => boolean) {
  const insertFileAttachment = vi.fn(() => true);
  let upload!: ReturnType<typeof useAttachmentUpload>;
  app = createApp({
    setup() {
      upload = useAttachmentUpload({
        api: apiMock,
        uploadImage: () => async (file, name) => ({ fileId: 'f1', name: name ?? 'n', mediaType: (file as File).type }),
        sessionId: () => 'sess_1',
        insertFileAttachment,
        dropSurfaceVisible: visible,
      });
      return () => h('div');
    },
  });
  app.mount(host);
  return { insertFileAttachment, upload: upload };
}

function fileDragEvent(type: string): Event {
  const file = new File(['x'], 'a.pdf', { type: 'application/pdf' });
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: { items: [{ kind: 'file', type: file.type, getAsFile: () => file, webkitGetAsEntry: () => null }], files: [file] },
  });
  Object.defineProperty(event, 'clientX', { value: 10 });
  Object.defineProperty(event, 'clientY', { value: 20 });
  return event;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
});

describe('window drop while the composer is hidden', () => {
  it('ignores window drag-over and drop when the drop surface is not visible', () => {
    const { insertFileAttachment, upload } = mountUpload(() => false);

    const over = fileDragEvent('dragover');
    document.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(false);

    document.dispatchEvent(fileDragEvent('dragenter'));
    expect(upload.isDragOver.value).toBe(false);

    const drop = fileDragEvent('drop');
    document.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(false);
    expect(insertFileAttachment).not.toHaveBeenCalled();
  });

  it('clears drag-over state when the surface hides mid-drag and the drop lands hidden', () => {
    let visible = true;
    const { insertFileAttachment, upload } = mountUpload(() => visible);

    document.dispatchEvent(fileDragEvent('dragenter'));
    expect(upload.isDragOver.value).toBe(true);

    visible = false;
    const drop = fileDragEvent('drop');
    document.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(false);
    expect(insertFileAttachment).not.toHaveBeenCalled();
    expect(upload.isDragOver.value).toBe(false);
  });

  it('still lets a hidden surface unwind drag-over depth on dragleave', () => {
    let visible = true;
    const { upload } = mountUpload(() => visible);

    document.dispatchEvent(fileDragEvent('dragenter'));
    expect(upload.isDragOver.value).toBe(true);

    visible = false;
    document.dispatchEvent(fileDragEvent('dragleave'));
    expect(upload.isDragOver.value).toBe(false);
  });

  it('keeps consuming window drops while the drop surface is visible', () => {
    const { insertFileAttachment } = mountUpload(() => true);

    const over = fileDragEvent('dragover');
    document.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);

    const drop = fileDragEvent('drop');
    document.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(insertFileAttachment).toHaveBeenCalledTimes(1);
  });
});
