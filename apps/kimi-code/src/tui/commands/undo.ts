import type { Component } from '@earendil-works/pi-tui';

import { WelcomeComponent } from '../components/chrome/welcome';
import { AgentGroupComponent } from '../components/messages/agent-group';
import { AssistantMessageComponent } from '../components/messages/assistant-message';
import { BackgroundAgentStatusComponent } from '../components/messages/background-agent-status';
import { CronMessageComponent } from '../components/messages/cron-message';
import { CompactionComponent } from '../components/dialogs/compaction';
import { ReadGroupComponent } from '../components/messages/read-group';
import { SkillActivationComponent } from '../components/messages/skill-activation';
import { ThinkingComponent } from '../components/messages/thinking';
import { ToolCallComponent } from '../components/messages/tool-call';
import { UserMessageComponent } from '../components/messages/user-message';
import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import type { TranscriptEntry } from '../types';
import { formatErrorMessage } from '../utils/event-payload';
import { getTranscriptComponentEntry } from '../utils/transcript-component-metadata';
import type { SlashCommandHost } from './dispatch';

// ---------------------------------------------------------------------------
// Undo command
// ---------------------------------------------------------------------------

export async function handleUndoCommand(
  host: SlashCommandHost,
  args: string = '',
): Promise<void> {
  const count = parseUndoCount(args);
  if (count === undefined) {
    host.showError('Usage: /undo [count], where count is a positive integer.');
    return;
  }

  host.startUndoPreview(count);
}

export async function commitUndoCommand(
  host: SlashCommandHost,
  count: number,
): Promise<boolean> {
  if (host.state.appState.streamingPhase !== 'idle') {
    host.showError('Cannot undo while streaming — press Esc or Ctrl-C first.');
    return false;
  }

  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return false;
  }

  const entries = host.state.transcriptEntries;
  const lastUserIndex = findUndoAnchorEntryIndex(entries, count);
  if (lastUserIndex === undefined) {
    host.showError('Nothing to undo.');
    return false;
  }

  try {
    await session.undoHistory(count);
  } catch (error) {
    const message = formatErrorMessage(error);
    host.showError(`Failed to undo: ${message}`);
    return false;
  }

  const children = host.state.transcriptContainer.children;
  const lastUserComponentIndex = findUndoAnchorComponentIndex(children, count);
  if (lastUserComponentIndex !== undefined) {
    removeUndoContextComponents(children, lastUserComponentIndex);
    host.state.transcriptContainer.invalidate();
  }

  const preservedEntries = entries.slice(lastUserIndex).filter(
    (entry) => !isUndoContextEntry(entry),
  );
  entries.splice(lastUserIndex, entries.length - lastUserIndex, ...preservedEntries);

  if (entries.length === 0) {
    renderWelcome(host);
  }

  host.state.ui.requestRender();
  return true;
}

function parseUndoCount(args: string): number | undefined {
  const value = args.trim();
  if (value.length === 0) return 1;
  if (!/^[1-9]\d*$/.test(value)) return undefined;
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : undefined;
}

export function isUndoAnchorEntry(entry: TranscriptEntry): boolean {
  return (
    entry.kind === 'user' ||
    (entry.kind === 'skill_activation' && entry.skillTrigger === 'user-slash')
  );
}

function findUndoAnchorEntryIndex(
  entries: readonly TranscriptEntry[],
  count: number,
): number | undefined {
  let found = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry !== undefined && isUndoAnchorEntry(entry)) {
      found++;
      if (found === count) return i;
    }
  }
  return undefined;
}

export function isUndoContextEntry(entry: TranscriptEntry): boolean {
  switch (entry.kind) {
    case 'user':
    case 'assistant':
    case 'tool_call':
    case 'thinking':
    case 'skill_activation':
    case 'cron':
      return true;
    case 'status':
      return entry.turnId !== undefined;
    case 'welcome':
      return false;
  }
}

function findUndoAnchorComponentIndex(
  children: readonly Component[],
  count: number,
): number | undefined {
  let found = 0;
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];
    if (child !== undefined && isUndoAnchorComponent(child)) {
      found++;
      if (found === count) return i;
    }
  }
  return undefined;
}

function removeUndoContextComponents(
  children: Component[],
  startIndex: number,
): void {
  for (let i = children.length - 1; i >= startIndex; i--) {
    const child = children[i];
    if (child !== undefined && isUndoContextComponent(child)) {
      children.splice(i, 1);
    }
  }
}

export function isUndoAnchorComponent(child: Component): boolean {
  return (
    child instanceof UserMessageComponent ||
    (child instanceof SkillActivationComponent && child.trigger === 'user-slash')
  );
}

export function isUndoBoundaryComponent(child: Component): boolean {
  const entry = getTranscriptComponentEntry(child);
  return entry?.compactionData !== undefined || child instanceof CompactionComponent;
}

export function isUndoContextComponent(child: Component): boolean {
  const entry = getTranscriptComponentEntry(child);
  if (entry !== undefined) {
    return isUndoContextEntry(entry);
  }

  return (
    child instanceof UserMessageComponent ||
    child instanceof AssistantMessageComponent ||
    child instanceof ThinkingComponent ||
    child instanceof ToolCallComponent ||
    child instanceof AgentGroupComponent ||
    child instanceof ReadGroupComponent ||
    child instanceof SkillActivationComponent ||
    child instanceof BackgroundAgentStatusComponent ||
    child instanceof CronMessageComponent
  );
}

function renderWelcome(host: SlashCommandHost): void {
  if (
    host.state.transcriptContainer.children.some(
      (child) => child instanceof WelcomeComponent,
    )
  ) {
    return;
  }
  host.state.transcriptContainer.addChild(
    new WelcomeComponent(host.state.appState, host.state.theme.colors),
  );
}
