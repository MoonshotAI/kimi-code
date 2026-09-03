import type { IEventService } from '#/app/event/event';

import { titleFromPromptMetadataText } from '#/agent/prompt/promptMetadataText';

import type { ISessionMetadata, SessionTitleKind } from './sessionMetadata';
import { SessionMetaUpdated } from './sessionMetaEvents';

export function isUntitled(title: string | undefined): boolean {
  return title === undefined || title.trim().length === 0 || title === 'New Session';
}

export interface PromptMetadataUpdateTarget {
  readonly metadata: ISessionMetadata;
  readonly eventService: IEventService;
  readonly sessionId: string;
}

export async function applyPromptMetadataUpdate(
  target: PromptMetadataUpdateTarget,
  text: string | undefined,
): Promise<void> {
  if (text === undefined) return;
  const current = await target.metadata.read();
  const patch: { lastPrompt: string; title?: string; titleKind?: SessionTitleKind } = {
    lastPrompt: text,
  };
  if (current.titleKind !== 'custom' && isUntitled(current.title)) {
    patch.title = titleFromPromptMetadataText(text);
    patch.titleKind = 'replaceable';
  }
  await target.metadata.update(patch);
  target.eventService.publish(
    new SessionMetaUpdated({
      payload: {
        agentId: 'main',
        sessionId: target.sessionId,
        title: patch.title,
        patch: {
          title: patch.title,
          isCustomTitle: patch.titleKind === undefined ? undefined : false,
          lastPrompt: text,
        },
      },
    }),
  );
}
