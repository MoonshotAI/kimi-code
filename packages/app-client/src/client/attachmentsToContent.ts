
import type { AppSkillAttachment, KimiWebApi } from '@moonshot-ai/app-core/api';
import type { TurnAttachment } from '@moonshot-ai/app-core/client';
import type { PromptAttachment } from './types';

export function promptAttachmentToTurnAttachment(
  api: Pick<KimiWebApi, 'getFileUrl' | 'getSessionMediaUrl'>,
  att: PromptAttachment,
): TurnAttachment {
  const sessionId = att.kind === 'file' ? undefined : att.sessionId;
  return {
    kind: att.kind,
    url: sessionId
      ? api.getSessionMediaUrl(sessionId, att.fileId)
      : api.getFileUrl(att.fileId),
    fileId: att.fileId,
    sessionId,
    name: att.name,
    mediaType: att.mediaType,
    size: att.size,
    ...(att.mediaOrdinal === undefined ? {} : { mediaOrdinal: att.mediaOrdinal }),
  };
}

export function attachmentsToContent(
  attachments: readonly PromptAttachment[] | undefined,
): AppSkillAttachment[] {
  const parts: AppSkillAttachment[] = [];
  for (const att of attachments ?? []) {
    if (att.kind === 'video') {
      parts.push({
        type: 'video',
        source: att.sessionId
          ? { kind: 'sessionMedia', fileId: att.fileId }
          : { kind: 'file', fileId: att.fileId },
        ...(att.name === undefined ? {} : { name: att.name }),
      });
    } else if (att.kind === 'file') {
      parts.push({
        type: 'file',
        fileId: att.fileId,
        name: att.name ?? '',
        mediaType: att.mediaType || 'application/octet-stream',
        size: att.size ?? 0,
      });
    } else {
      parts.push({
        type: 'image',
        source: att.sessionId
          ? { kind: 'sessionMedia', fileId: att.fileId }
          : { kind: 'file', fileId: att.fileId },
        ...(att.name === undefined ? {} : { name: att.name }),
      });
    }
  }
  return parts;
}
