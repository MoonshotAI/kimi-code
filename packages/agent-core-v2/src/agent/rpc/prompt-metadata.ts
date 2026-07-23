/**
 * `rpc` domain (Agent) — v1-compatible prompt metadata helpers.
 *
 * Derives title and last-prompt text from native and legacy prompt payloads,
 * persists metadata through `sessionMetadata`, and publishes live updates
 * through `event`. Shared by the native `rpc` prompt path and the v1 legacy
 * prompt adapter so both surfaces keep the same easy-title behavior.
 */

import type { IEventService } from '#/app/event/event';
import type { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

import {
  promptMetadataTextFromContentParts,
  promptMetadataTextFromText,
  titleFromPromptMetadataText,
} from '#/agent/prompt/promptMetadataText';

import type {
  ActivatePluginCommandPayload,
  ActivateSkillPayload,
  PromptPayload,
} from './core-api';

export { promptMetadataTextFromContentParts, titleFromPromptMetadataText };

export function promptMetadataTextFromPayload(payload: PromptPayload): string | undefined {
  return promptMetadataTextFromContentParts(payload.input);
}

export function promptMetadataTextFromSkill(payload: ActivateSkillPayload): string | undefined {
  const args = payload.args?.trim();
  return promptMetadataTextFromText(
    args === undefined || args.length === 0 ? `/${payload.name}` : `/${payload.name} ${args}`,
  );
}

export function promptMetadataTextFromPluginCommand(
  payload: ActivatePluginCommandPayload,
): string | undefined {
  const args = payload.args?.trim();
  const command = `/${payload.pluginId}:${payload.commandName}`;
  return promptMetadataTextFromText(
    args === undefined || args.length === 0 ? command : `${command} ${args}`,
  );
}

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
  const patch: { lastPrompt: string; title?: string; isCustomTitle?: boolean } = {
    lastPrompt: text,
  };
  if (!current.isCustomTitle && isUntitled(current.title)) {
    patch.title = titleFromPromptMetadataText(text);
    patch.isCustomTitle = false;
  }
  await target.metadata.update(patch);
  target.eventService.publish({
    type: 'session.meta.updated',
    payload: {
      agentId: 'main',
      sessionId: target.sessionId,
      title: patch.title,
      patch: {
        title: patch.title,
        isCustomTitle: patch.isCustomTitle,
        lastPrompt: text,
      },
    },
  });
}
