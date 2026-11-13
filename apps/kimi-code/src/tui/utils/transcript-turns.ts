import type { Component } from '@moonshot-ai/pi-tui';

import { PluginCommandComponent } from '#/tui/components/messages/plugin-command';
import { SkillActivationComponent } from '#/tui/components/messages/skill-activation';
import {
  ReplayTurnBoundaryComponent,
  UserMessageComponent,
} from '#/tui/components/messages/user-message';
import { getTranscriptComponentEntry } from '#/tui/utils/transcript-component-metadata';

export function isTurnBoundaryComponent(child: Component): boolean {
  if (
    !(child instanceof UserMessageComponent) &&
    !(child instanceof SkillActivationComponent) &&
    !(child instanceof PluginCommandComponent) &&
    !(child instanceof ReplayTurnBoundaryComponent)
  ) {
    return false;
  }
  const entry = getTranscriptComponentEntry(child);
  if (entry === undefined) return false;
  return startsNewTurn(entry.turnId);
}

function startsNewTurn(turnId: string | undefined): boolean {
  const liveTurnStart = turnId === undefined;
  const replayedTurnStart = turnId?.startsWith('replay:') === true;
  return liveTurnStart || replayedTurnStart;
}
