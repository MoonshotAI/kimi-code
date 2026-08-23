import { describe, expect, it, vi } from 'vitest';

import {
  attachmentsToContent,
  promptAttachmentToTurnAttachment,
  toPromptAttachment,
} from '../src/client/attachmentsToContent';

describe('prompt attachment mapping', () => {
  it('keeps global uploads in the global file namespace', () => {
    expect(
      attachmentsToContent([
        { fileId: 'f_img', kind: 'image' },
        { fileId: 'f_vid', kind: 'video' },
        { fileId: 'f_pdf', kind: 'file', name: 'a.pdf', mediaType: 'application/pdf', size: 42 },
      ]),
    ).toEqual([
      { type: 'image', source: { kind: 'file', fileId: 'f_img' } },
      { type: 'video', source: { kind: 'file', fileId: 'f_vid' } },
      { type: 'file', fileId: 'f_pdf', name: 'a.pdf', mediaType: 'application/pdf', size: 42 },
    ]);
  });

  it('maps session-scoped images and videos back to sessionMedia', () => {
    expect(
      attachmentsToContent([
        { fileId: 'f_img', kind: 'image', sessionId: 'sess_1' },
        { fileId: 'f_vid', kind: 'video', sessionId: 'sess_1' },
      ]),
    ).toEqual([
      { type: 'image', source: { kind: 'sessionMedia', fileId: 'f_img' } },
      { type: 'video', source: { kind: 'sessionMedia', fileId: 'f_vid' } },
    ]);
  });

  it('preserves provenance and metadata across queue edit and resend', () => {
    const api = {
      getFileUrl: vi.fn((fileId: string) => `file://${fileId}`),
      getSessionMediaUrl: vi.fn((sessionId: string, fileId: string) =>
        `media://${sessionId}/${fileId}`),
    };

    const editable = promptAttachmentToTurnAttachment(api, {
      fileId: 'f_img',
      kind: 'image',
      sessionId: 'sess_1',
      name: 'history.png',
      mediaType: 'image/png',
      size: 42,
    });

    expect(editable).toEqual({
      fileId: 'f_img',
      kind: 'image',
      url: 'media://sess_1/f_img',
      sessionId: 'sess_1',
      name: 'history.png',
      mediaType: 'image/png',
      size: 42,
    });
    expect(api.getSessionMediaUrl).toHaveBeenCalledWith('sess_1', 'f_img');
    expect(api.getFileUrl).not.toHaveBeenCalled();
    const restoredPrompt = toPromptAttachment({
      localId: 'att_1',
      name: editable.name ?? 'image',
      kind: editable.kind,
      previewUrl: editable.url,
      uploading: false,
      fileId: editable.fileId,
      sessionId: editable.sessionId,
      mediaType: editable.mediaType,
      size: editable.size,
    });
    expect(restoredPrompt).toEqual({
      fileId: 'f_img',
      kind: 'image',
      sessionId: 'sess_1',
      name: 'history.png',
      mediaType: 'image/png',
      size: 42,
    });
    expect(attachmentsToContent([restoredPrompt])).toEqual([
      { type: 'image', source: { kind: 'sessionMedia', fileId: 'f_img' } },
    ]);
  });

  it('carries the caller-supplied orderHint (the queue payload index is the interleave)', () => {
    const api = {
      getFileUrl: vi.fn((fileId: string) => `file://${fileId}`),
      getSessionMediaUrl: vi.fn(),
    };
    // A queued prompt submitted as [file, image]: the array index IS the
    // submit-time interleave, and mapping with it keeps the reload's
    // restamp from collapsing to media-first.
    const mapped = [
      { fileId: 'f_a', kind: 'file' as const, name: 'a.pdf' },
      { fileId: 'f_img', kind: 'image' as const, name: 'shot.png' },
    ].map((a, index) => promptAttachmentToTurnAttachment(api, a, index));

    expect(mapped.map((a) => [a.kind, a.orderHint])).toEqual([
      ['file', 0],
      ['image', 1],
    ]);
    // Without the argument no hint is stamped (legacy callers).
    expect(promptAttachmentToTurnAttachment(api, { fileId: 'f_a', kind: 'file' }).orderHint).toBeUndefined();
  });
});
