import type { ChatTurn, ToolMedia, TurnAttachment } from './types';

export function collectTurnImages(turns: readonly ChatTurn[]): ToolMedia[] {
  const images: ToolMedia[] = [];
  for (const turn of turns) {
    for (const tool of turn.tools ?? []) {
      if (tool.media?.kind === 'image') images.push(tool.media);
    }
  }
  return images;
}

export function turnAttachmentToMedia(attachment: TurnAttachment & { kind: 'image' | 'video' }): ToolMedia {
  return {
    kind: attachment.kind,
    url: attachment.url,
    name: attachment.name,
    mimeType: attachment.mediaType,
    bytes: attachment.size,
    fileId: attachment.fileId,
    sessionId: attachment.sessionId,
  };
}

export function collectTurnAttachmentImages(
  turns: readonly ChatTurn[],
  hiddenKeys?: (turn: ChatTurn) => ReadonlySet<string>,
): ToolMedia[] {
  const images: ToolMedia[] = [];
  for (const turn of turns) {
    const hidden = hiddenKeys?.(turn);
    for (const attachment of turn.attachments ?? []) {
      if (attachment.kind !== 'image') continue;
      if (hidden?.has(`${attachment.sessionId ?? ''}:${attachment.fileId}`)) continue;
      images.push(turnAttachmentToMedia({ ...attachment, kind: attachment.kind }));
    }
  }
  return images;
}
