import { describe, expect, it, vi } from 'vitest';
import { pendingPromptTurn } from '@moonshot-ai/app-core/client';
import {
  buildMessageCopyFlavor,
  parseComposerClipboardPayload,
} from '@moonshot-ai/app-composer/features/attachment';
import { serializeAttachment } from '@moonshot-ai/app-composer/model';

import {
  attachmentsToContent,
  promptAttachmentToTurnAttachment,
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
      mediaOrdinal: 3,
    });

    expect(editable).toEqual({
      fileId: 'f_img',
      kind: 'image',
      url: 'media://sess_1/f_img',
      sessionId: 'sess_1',
      name: 'history.png',
      mediaType: 'image/png',
      size: 42,
      mediaOrdinal: 3,
    });
    expect(api.getSessionMediaUrl).toHaveBeenCalledWith('sess_1', 'f_img');
    expect(api.getFileUrl).not.toHaveBeenCalled();
    expect(attachmentsToContent([editable])).toEqual([
      { type: 'image', source: { kind: 'sessionMedia', fileId: 'f_img' }, name: 'history.png' },
    ]);
  });

  it('preserves the original media filename through sent-message copy flavor', () => {
    const content = attachmentsToContent([{
      fileId: 'f_img',
      kind: 'image',
      name: 'vacation.png',
      mediaOrdinal: 1,
    }]);
    const turn = pendingPromptTurn({
      id: 'msg_1',
      sessionId: 'sess_1',
      role: 'user',
      content: [
        { type: 'text', text: serializeAttachment({ attId: 'm1', name: 'Image 1', kind: 'image' }) },
        ...content,
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
    }, 1, { sessionId: 'sess_1', getFileUrl: (fileId) => `file://${fileId}` });

    const flavor = buildMessageCopyFlavor(turn.text, turn.attachments);
    expect(flavor).toBeDefined();
    expect(parseComposerClipboardPayload(flavor!)?.attachments[0]).toMatchObject({
      name: 'vacation.png',
      mediaOrdinal: 1,
    });
  });
});
