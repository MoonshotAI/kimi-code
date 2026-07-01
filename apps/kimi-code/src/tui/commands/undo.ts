import type { Component } from '@moonshot-ai/pi-tui';
import type { ContextMessage } from '@moonshot-ai/kimi-code-sdk';
import { isKimiError } from '@moonshot-ai/kimi-code-sdk';

import { WelcomeComponent } from '../components/chrome/welcome';
import { CompactionComponent } from '../components/dialogs/compaction';
import {
  UndoSelectorComponent,
  type UndoChoice,
} from '../components/dialogs/undo-selector';
import { AgentGroupComponent } from '../components/messages/agent-group';
import { AgentSwarmProgressComponent } from '../components/messages/agent-swarm-progress';
import { AssistantMessageComponent } from '../components/messages/assistant-message';
import { BackgroundAgentStatusComponent } from '../components/messages/background-agent-status';
import { CronMessageComponent } from '../components/messages/cron-message';
import { ReadGroupComponent } from '../components/messages/read-group';
import { SkillActivationComponent } from '../components/messages/skill-activation';
import { PluginCommandComponent } from '../components/messages/plugin-command';
import { ThinkingComponent } from '../components/messages/thinking';
import { ToolCallComponent } from '../components/messages/tool-call';
import { UserMessageComponent } from '../components/messages/user-message';
import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import type { TranscriptEntry } from '../types';
import { formatErrorMessage } from '../utils/event-payload';
import { getTranscriptComponentEntry } from '../utils/transcript-component-metadata';
import { nextTranscriptId } from '../utils/transcript-id';
import type { SlashCommandHost } from './dispatch';

// ---------------------------------------------------------------------------
// Undo command
// ---------------------------------------------------------------------------

interface UndoAvailability {
  readonly maxCount: number;
  readonly stoppedAtCompaction: boolean;
}

type UndoSessionContext = Awaited<
  ReturnType<NonNullable<SlashCommandHost['session']>['getContext']>
>;

const UNDO_LIMIT_STATUS_TURN_ID = 'undo-limit-status';

export async function handleUndoCommand(
  host: SlashCommandHost,
  args: string = '',
): Promise<void> {
  if (host.state.appState.streamingPhase !== 'idle') {
    host.showError('Cannot undo while streaming — press Esc or Ctrl-C first.');
    return;
  }

  const trimmed = args.trim();
  if (trimmed.length === 0) {
    await showUndoSelector(host);
    return;
  }

  const count = parseUndoCount(trimmed);
  if (count === undefined) {
    host.showError('Usage: /undo [count], where count is a positive integer.');
    return;
  }

  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const availability = await resolveUndoAvailability(host);
  if (count > availability.maxCount) {
    showUndoLimitStatus(host, formatUndoLimitMessage(count, availability));
    return;
  }

  await undoByCount(host, count);
}

async function undoByCount(host: SlashCommandHost, count: number): Promise<boolean> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return false;
  }

  const entries = host.state.transcriptEntries;
  const lastUserIndex = findUndoAnchorEntryIndex(entries, count);
  if (lastUserIndex === undefined) {
    showUndoLimitStatus(host, 'Nothing to undo.');
    return false;
  }

  try {
    await session.undoHistory(count);
  } catch (error) {
    const limit = undoLimitFromError(error);
    if (limit !== undefined) {
      showUndoLimitStatus(host, formatUndoLimitMessage(limit.requestedCount, limit));
      return false;
    }
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

async function showUndoSelector(host: SlashCommandHost): Promise<void> {
  if (host.session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const availability = await resolveUndoAvailability(host);
  const choices = createUndoChoices(
    host.state.transcriptEntries,
    host.state.transcriptContainer.children,
    availability.maxCount,
  );
  if (choices.length === 0) {
    showUndoLimitStatus(host, formatNothingToUndoMessage(availability));
    return;
  }

  host.mountEditorReplacement(
    new UndoSelectorComponent({
      choices,
      onSelect: (choice) => {
        void undoByCount(host, choice.count).then((undone) => {
          if (undone) {
            host.restoreInputText(choice.input);
            return;
          }
          host.restoreEditor();
        });
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

function parseUndoCount(args: string): number | undefined {
  const value = args.trim();
  if (value.length === 0) return 1;
  if (!/^[1-9]\d*$/.test(value)) return undefined;
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : undefined;
}

async function resolveUndoAvailability(
  host: SlashCommandHost,
): Promise<UndoAvailability> {
  const local = undoAvailabilityFromTranscript(
    host.state.transcriptEntries,
    host.state.transcriptContainer.children,
  );
  const context = await getSessionContext(host.session);
  if (context === undefined) return local;

  const activeContext = undoAvailabilityFromContext(context.history);
  return {
    maxCount: Math.min(local.maxCount, activeContext.maxCount),
    stoppedAtCompaction:
      local.stoppedAtCompaction || activeContext.stoppedAtCompaction,
  };
}

async function getSessionContext(
  session: SlashCommandHost['session'],
): Promise<UndoSessionContext | undefined> {
  const getContext = (
    session as { getContext?: () => Promise<UndoSessionContext> } | undefined
  )?.getContext;
  if (session === undefined || getContext === undefined) return undefined;
  try {
    return await getContext.call(session);
  } catch {
    return undefined;
  }
}

function undoAvailabilityFromTranscript(
  entries: readonly TranscriptEntry[],
  children: readonly Component[],
): UndoAvailability {
  const { anchors, stoppedAtCompaction } = activeUndoAnchorEntries(entries, children);
  return {
    maxCount: anchors.length,
    stoppedAtCompaction,
  };
}

function undoAvailabilityFromContext(
  history: readonly ContextMessage[],
): UndoAvailability {
  let maxCount = 0;
  let stoppedAtCompaction = false;

  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message === undefined) continue;
    if (message.origin?.kind === 'injection') continue;
    if (message.origin?.kind === 'compaction_summary') {
      stoppedAtCompaction = true;
      break;
    }
    if (isContextUndoAnchor(message)) maxCount++;
  }

  return { maxCount, stoppedAtCompaction };
}

function isContextUndoAnchor(message: ContextMessage): boolean {
  if (message.role !== 'user') return false;
  const origin = message.origin;
  if (origin === undefined || origin.kind === 'user') return true;
  if (origin.kind === 'skill_activation') {
    return origin.trigger === 'user-slash';
  }
  if (origin.kind === 'plugin_command') {
    return origin.trigger === 'user-slash';
  }
  return false;
}

function createUndoChoices(
  entries: readonly TranscriptEntry[],
  children: readonly Component[],
  maxCount: number,
): readonly UndoChoice[] {
  if (maxCount <= 0) return [];
  const anchors = activeUndoAnchorEntries(entries, children).anchors.slice(-maxCount);
  return anchors.map((entry, index) => ({
    id: entry.id,
    count: anchors.length - index,
    input: formatUndoChoiceInput(entry),
    label: formatUndoChoiceLabel(entry),
  }));
}

function activeUndoAnchorEntries(
  entries: readonly TranscriptEntry[],
  children: readonly Component[],
): { readonly anchors: readonly TranscriptEntry[]; readonly stoppedAtCompaction: boolean } {
  const lastCompactionChildIndex = children.findLastIndex(
    (child) => child instanceof CompactionComponent,
  );
  if (lastCompactionChildIndex >= 0) {
    return {
      anchors: children
        .slice(lastCompactionChildIndex + 1)
        .map((child) => getTranscriptComponentEntry(child))
        .filter((entry): entry is TranscriptEntry => entry !== undefined)
        .filter(isUndoAnchorEntry),
      stoppedAtCompaction: true,
    };
  }

  const lastCompactionEntryIndex = entries.findLastIndex(
    (entry) => entry.compactionData !== undefined,
  );
  const activeEntries =
    lastCompactionEntryIndex >= 0 ? entries.slice(lastCompactionEntryIndex + 1) : entries;
  return {
    anchors: activeEntries.filter(isUndoAnchorEntry),
    stoppedAtCompaction: lastCompactionEntryIndex >= 0,
  };
}

function formatUndoChoiceLabel(
  entry: TranscriptEntry,
): string {
  if (entry.kind === 'skill_activation') {
    const name = singleLine(
      entry.skillName ?? entry.content.replace(/^Activated skill:\s*/, ''),
    );
    const args = singleLine(entry.skillArgs ?? '');
    if (name.length === 0) return 'Skill: unknown';
    return args.length > 0 ? `/${name} ${args}` : `/${name}`;
  }
  if (entry.kind === 'plugin_command' && entry.pluginCommandData !== undefined) {
    return formatPluginCommandSlash(entry.pluginCommandData) ?? 'User message';
  }

  const content = singleLine(entry.content);
  const imageCount = entry.imageAttachmentIds?.length ?? 0;
  if (content.length > 0) return content;
  if (imageCount > 0) {
    return `User message (${String(imageCount)} ${imageCount === 1 ? 'image' : 'images'})`;
  }
  return 'User message';
}

function formatUndoChoiceInput(entry: TranscriptEntry): string {
  if (entry.kind === 'skill_activation') {
    const name = singleLine(
      entry.skillName ?? entry.content.replace(/^Activated skill:\s*/, ''),
    );
    const args = singleLine(entry.skillArgs ?? '');
    if (name.length === 0) return '';
    return args.length > 0 ? `/${name} ${args}` : `/${name}`;
  }
  if (entry.kind === 'plugin_command' && entry.pluginCommandData !== undefined) {
    return formatPluginCommandSlash(entry.pluginCommandData) ?? entry.content;
  }
  return entry.content;
}

function formatPluginCommandSlash(data: NonNullable<TranscriptEntry['pluginCommandData']>): string | undefined {
  const name = `${data.pluginId}:${data.commandName}`;
  const args = singleLine(data.args ?? '');
  if (name.length === 0) return undefined;
  return args.length > 0 ? `/${name} ${args}` : `/${name}`;
}

function singleLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

function formatUndoLimitMessage(
  requestedCount: number,
  availability: UndoAvailability,
): string {
  const reason = availability.stoppedAtCompaction ? ' after the last compaction' : '';
  const requested = formatPromptCount(requestedCount);
  const max = formatPromptCount(availability.maxCount);
  return `Cannot undo ${requested}; only ${max} can be undone in the active context${reason}.`;
}

function formatNothingToUndoMessage(availability: UndoAvailability): string {
  if (availability.stoppedAtCompaction) {
    return 'Nothing to undo after the last compaction.';
  }
  return 'Nothing to undo.';
}

function formatPromptCount(count: number): string {
  return `${String(count)} ${count === 1 ? 'prompt' : 'prompts'}`;
}

function showUndoLimitStatus(host: SlashCommandHost, message: string): void {
  host.appendTranscriptEntry({
    id: nextTranscriptId(),
    kind: 'status',
    turnId: UNDO_LIMIT_STATUS_TURN_ID,
    renderMode: 'plain',
    content: message,
  });
}

function undoLimitFromError(
  error: unknown,
): (UndoAvailability & { readonly requestedCount: number }) | undefined {
  if (!isKimiError(error)) return undefined;
  const details = error.details;
  if (details?.['reason'] !== 'undo_limit') return undefined;
  const requestedCount = details['requestedCount'];
  const maxCount = details['undoableCount'];
  const stoppedAtCompaction = details['stoppedAtCompaction'];
  if (
    typeof requestedCount !== 'number' ||
    typeof maxCount !== 'number' ||
    typeof stoppedAtCompaction !== 'boolean'
  ) {
    return undefined;
  }
  return { requestedCount, maxCount, stoppedAtCompaction };
}

function isUndoAnchorEntry(entry: TranscriptEntry): boolean {
  return (
    entry.kind === 'user' ||
    (entry.kind === 'skill_activation' && entry.skillTrigger === 'user-slash') ||
    entry.kind === 'plugin_command'
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

function isUndoContextEntry(entry: TranscriptEntry): boolean {
  switch (entry.kind) {
    case 'user':
    case 'assistant':
    case 'tool_call':
    case 'thinking':
    case 'skill_activation':
    case 'plugin_command':
    case 'cron':
      return true;
    case 'status':
    case 'goal':
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

function isUndoAnchorComponent(child: Component): boolean {
  return (
    child instanceof UserMessageComponent ||
    (child instanceof SkillActivationComponent && child.trigger === 'user-slash') ||
    child instanceof PluginCommandComponent
  );
}

function isUndoContextComponent(child: Component): boolean {
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
    child instanceof AgentSwarmProgressComponent ||
    child instanceof ReadGroupComponent ||
    child instanceof SkillActivationComponent ||
    child instanceof PluginCommandComponent ||
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
    new WelcomeComponent(host.state.appState),
  );
}
