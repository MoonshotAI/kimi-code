import type { IEventService } from '#/app/event/event';

import { titleFromPromptMetadataText } from '#/agent/prompt/promptMetadataText';

import type { ISessionMetadata } from './sessionMetadata';
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
  const title = titleFromPromptMetadataText(text);
  const applied = await target.metadata.applyPromptMetadata(text, title);
  target.eventService.publish(
    new SessionMetaUpdated({
      payload: {
        agentId: 'main',
        sessionId: target.sessionId,
        title: applied ? title : undefined,
        patch: {
          title: applied ? title : undefined,
          isCustomTitle: applied ? false : undefined,
          lastPrompt: text,
        },
      },
    }),
  );
}
