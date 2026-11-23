
import type { AppMessageContent, AppSkillAttachment, KimiWebApi } from '@moonshot-ai/app-core/api';
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

export function queuedContentAttachment(
  api: Pick<KimiWebApi, 'getFileUrl' | 'getSessionMediaUrl'>,
  sessionId: string,
  part: AppMessageContent,
): TurnAttachment[] {
  if (part.type === 'file') {
    return [{ kind: 'file', url: api.getFileUrl(part.fileId), fileId: part.fileId, name: part.name, mediaType: part.mediaType, size: part.size }];
  }
  if (part.type !== 'image' && part.type !== 'video') return [];
  const source = part.source;
  if (source.kind === 'file') {
    return [{ kind: part.type, url: api.getFileUrl(source.fileId), fileId: source.fileId, name: part.name }];
  }
  if (source.kind === 'sessionMedia') {
    return [{ kind: part.type, url: api.getSessionMediaUrl(sessionId, source.fileId), fileId: source.fileId, sessionId, name: part.name }];
  }
  if (source.kind === 'url') return [{ kind: part.type, url: source.url, name: part.name }];
  return [{ kind: part.type, url: `data:${source.mediaType};base64,${source.data}`, name: part.name }];
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
