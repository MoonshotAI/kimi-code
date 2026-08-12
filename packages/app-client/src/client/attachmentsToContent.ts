// packages/app-client/src/client/attachmentsToContent.ts
// Pure TS — no Vue, no side effects.

import type { AppSkillAttachment } from '@moonshot-ai/app-core/api';
import type { PromptAttachment } from './types';

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
    if (att.kind === 'video') parts.push({ type: 'video', source: { kind: 'file', fileId: att.fileId } });
    else if (att.kind === 'file') {
      parts.push({
        type: 'file',
        fileId: att.fileId,
        name: att.name ?? '',
        mediaType: att.mediaType || 'application/octet-stream',
        size: att.size ?? 0,
      });
    } else parts.push({ type: 'image', source: { kind: 'file', fileId: att.fileId } });
  }
  return parts;
}
