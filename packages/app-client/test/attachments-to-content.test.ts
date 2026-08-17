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
});
