
export const MEDIA_INDEX_PREFIX = 'm';

export function attachmentTargetFor<T extends { kind: string; fileId?: string; sessionId?: string }>(
  attId: string,
  attachments: readonly T[] | undefined,
  resources?: readonly { attId: string; fileId?: string; sessionId?: string }[],
): T | undefined {
  if (attachments === undefined) return undefined;
  const resource = resources?.find((entry) => entry.attId === attId);
  if (resource !== undefined) {
    return resource.fileId === undefined ? undefined : attachments.find((attachment) => attachment.fileId === resource.fileId && attachment.sessionId === resource.sessionId);
  }
  let index: number;
  let inFamily: (att: T) => boolean;
  if (/^[1-9]\d*$/.test(attId)) {
    index = Number(attId);
    inFamily = (att) => att.kind === 'file';
  } else if (/^m[1-9]\d*$/.test(attId)) {
    index = Number(attId.slice(1));
    inFamily = (att) => att.kind === 'image' || att.kind === 'video';
  } else {
    return undefined;
  }
  let position = 0;
  for (const att of attachments) {
    if (!inFamily(att)) continue;
    position += 1;
    if (position === index) return att;
  }
  return undefined;
}

export interface AttachmentTargetAttrs {
  'data-attachment-kind'?: string;
  'data-attachment-url'?: string;
  'data-attachment-file-id'?: string;
  'data-attachment-media-type'?: string;
  'data-attachment-size'?: number;
  'data-attachment-session-id'?: string;
  tabindex?: number;
  role?: string;
}

export function attachmentTargetAttrs<
  T extends { kind: string; url: string; fileId?: string; mediaType?: string; size?: number; sessionId?: string },
>(attId: string, attachments: readonly T[] | undefined, resources?: readonly { attId: string; fileId?: string; sessionId?: string }[]): AttachmentTargetAttrs {
  const target = attachmentTargetFor(attId, attachments, resources);
  if (target === undefined) return {};
  const openable = target.url !== '';
  return {
    'data-attachment-kind': target.kind,
    'data-attachment-url': openable ? target.url : undefined,
    'data-attachment-file-id': target.fileId,
    'data-attachment-media-type': target.mediaType,
    'data-attachment-size': target.size,
    'data-attachment-session-id': openable ? target.sessionId : undefined,
    tabindex: openable ? 0 : undefined,
    role: openable ? 'button' : undefined,
  };
}
