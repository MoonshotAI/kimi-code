// packages/app-client/src/client/attachmentsToContent.ts
// Pure TS — no Vue, no side effects.

import type { AppSkillAttachment, KimiWebApi } from '@moonshot-ai/app-core/api';
import type { TurnAttachment } from '@moonshot-ai/app-core/client';
import type { Attachment } from '../composables/useAttachmentUpload';
import type { PromptAttachment } from './types';

/** Collapse a ready Composer attachment into the prompt payload shape. The
 *  caller filters out attachments without a file id before invoking this. */
export function toPromptAttachment(att: Attachment): PromptAttachment {
  return {
    fileId: att.fileId!,
    kind: att.kind,
    sessionId: att.kind === 'file' ? undefined : att.sessionId,
    name: att.name,
    mediaType: att.mediaType,
    size: att.size,
  };
}

/** Rebuild a prompt attachment for Composer/queue display without losing which
 *  daemon store owns the file id. An add-order stamp (seq) rides along when
 *  present — the chip draft round-trips it so a remount keeps the payload
 *  interleave instead of re-stamping. `orderHint` carries the source
 *  position (a queued prompt's attachment array IS the submit payload
 *  order, so callers pass the array index) for the refill's interleave
 *  restore — see restampRefillByOrderHint. */
export function promptAttachmentToTurnAttachment(
  api: Pick<KimiWebApi, 'getFileUrl' | 'getSessionMediaUrl'>,
  att: PromptAttachment & { seq?: number },
  orderHint?: number,
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
    seq: att.seq,
    orderHint,
  };
}

/**
 * Build the wire-bound content parts for uploaded attachments: images/videos
 * become media parts keyed by the upload id; any other kind becomes a file
 * part the server materializes and hands to the model as a path reference.
 * Shared by prompt submission (useWorkspaceState.submitPromptInternal) and
 * skill activation (useModelProviderState.activateSkill).
 */
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
      });
    }
  }
  return parts;
}
