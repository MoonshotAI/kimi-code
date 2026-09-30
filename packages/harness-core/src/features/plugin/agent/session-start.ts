import {
  createHistoryMessageBuilder,
  extractText,
  type AgentCommands,
  type AgentFeatureStore,
  type BranchRef,
  type HistoryMessage,
  type Projection,
  type RecordEvent,
  type TurnBeforeStep,
} from '@moonshot-ai/agent-core';
import { watch } from '@moonshot-ai/agent-core/kernel/index';

import type { SkillCatalogFace } from '#/features/skill/feature';
import { escapeXmlAttr } from '#/features/skill/catalog/xml-escape';
import type { SkillDefinition } from '#/features/skill/catalog/types';

import type { PluginFace } from '../face';
import type {
  EnabledPluginSessionStart,
  PluginMutationSummary,
  ReloadSummary,
} from '../types';

import { PLUGIN_CHANGE_REMIND_KEY, renderPluginChangeReminder } from './change';

export const PLUGIN_SESSION_START_REMIND_KEY = 'plugin-session-start';
export const PLUGIN_SESSION_START_SNAPSHOT = 'plugin.session_start.snapshot';

export const SUPERSEDES_SUFFIX =
  'This supersedes any earlier plugin_session_start reminder in this session.';

export const NO_ACTIVE_SESSION_STARTS =
  `There are currently no active plugin session starts. ${SUPERSEDES_SUFFIX}`;

export interface PluginSessionStartSnapshotState {
  readonly initialized: boolean;
  readonly content?: string;
}

export const pluginSessionStartProjection: Projection<
  PluginSessionStartSnapshotState,
  RecordEvent,
  BranchRef
> = {
  initial: () => ({ initialized: false }),
  reduce: (state, event) => {
    if (event.type !== PLUGIN_SESSION_START_SNAPSHOT) return state;
    const content = event['content'];
    return { initialized: true, content: typeof content === 'string' ? content : undefined };
  },
};

export interface PluginSessionStartReminderDeps {
  readonly agent: AgentCommands;
  readonly store: AgentFeatureStore;
  readonly sessionId: string;
  readonly face: PluginFace;
  readonly catalog: () => SkillCatalogFace | undefined;
  readonly warn?: (message: string) => void;
}

interface LatestInjection {
  readonly entry: HistoryMessage;
  readonly rendered?: string;
}

export function createPluginSessionStartReminder(
  deps: PluginSessionStartReminderDeps,
): TurnBeforeStep {
  const { agent, store, face } = deps;
  const snapshot = store.fold(pluginSessionStartProjection);
  let localSnapshot: PluginSessionStartSnapshotState | undefined;
  let refreshPending = false;
  let pendingMutationCatalogChanges = 0;
  let seenMutation: PluginMutationSummary | null = null;
  let seenReload: ReloadSummary | null = null;
  const warnedMissingSkills = new Set<string>();

  const remind = (text: string, key: string): void => {
    agent.remind(createHistoryMessageBuilder().systemReminder(text).userMessage(), { key });
  };

  watch([face.lastMutation, face.lastReload], ([mutation, reload]) => {
    if (mutation !== null && mutation !== seenMutation) {
      seenMutation = mutation;
      pendingMutationCatalogChanges++;
      remind(renderPluginChangeReminder(mutation.mutation), PLUGIN_CHANGE_REMIND_KEY);
    }
    if (reload !== null && reload !== seenReload) {
      seenReload = reload;
      if (pendingMutationCatalogChanges > 0) {
        pendingMutationCatalogChanges--;
        return;
      }
      refreshPending = true;
    }
  });

  const recordSnapshot = (content: string | undefined): void => {
    localSnapshot = { initialized: true, content };
    void store.dispatch({
      type: PLUGIN_SESSION_START_SNAPSHOT,
      content: content ?? null,
    });
  };

  const renderSessionStart = async (): Promise<string | undefined> => {
    const sessionStarts = await face.enabledSessionStarts();
    if (sessionStarts.length === 0) return undefined;
    const catalog = deps.catalog();
    if (catalog === undefined) return undefined;
    await catalog.ready;
    const blocks: string[] = [];
    for (const sessionStart of sessionStarts) {
      const skill = face.getPluginSkill(sessionStart.pluginId, sessionStart.skillName);
      if (skill === undefined) {
        const key = `${sessionStart.pluginId}:${sessionStart.skillName}`;
        if (!warnedMissingSkills.has(key)) {
          warnedMissingSkills.add(key);
          deps.warn?.(
            `plugin sessionStart skill not found: ${sessionStart.pluginId}:${sessionStart.skillName}`,
          );
        }
        continue;
      }
      blocks.push(
        renderSessionStartBlock(
          sessionStart,
          skill,
          catalog.renderSkillPrompt(skill, '', { sessionId: deps.sessionId }),
        ),
      );
    }
    return blocks.length > 0 ? blocks.join('\n') : undefined;
  };

  const resolveDesired = async (
    forceRefresh: boolean,
    latest: LatestInjection | undefined,
  ): Promise<string | undefined> => {
    const current = localSnapshot ?? snapshot.value;
    if (!forceRefresh && current.initialized) return current.content;
    if (!forceRefresh && latest?.rendered !== undefined) {
      const content = frozenSessionStartContent(latest.rendered);
      recordSnapshot(content);
      return content;
    }
    const content = await renderSessionStart();
    recordSnapshot(content);
    return content;
  };

  return async ({ messages }) => {
    const latest = lastSessionStartInjection(messages);
    const forceRefresh = refreshPending;
    const desired = await resolveDesired(forceRefresh, latest);
    refreshPending = false;
    if (desired === undefined) {
      if (latest === undefined && (!forceRefresh || !shouldNeutralizePluginSessionStart(messages))) {
        return;
      }
      if (latest !== undefined && latest.rendered === NO_ACTIVE_SESSION_STARTS) return;
      remind(NO_ACTIVE_SESSION_STARTS, PLUGIN_SESSION_START_REMIND_KEY);
      return;
    }
    if (latest === undefined) {
      remind(desired, PLUGIN_SESSION_START_REMIND_KEY);
      return;
    }
    if (
      !forceRefresh &&
      (latest.rendered === desired.trim() ||
        latest.rendered === `${desired}\n\n${SUPERSEDES_SUFFIX}`.trim())
    ) {
      return;
    }
    remind(`${desired}\n\n${SUPERSEDES_SUFFIX}`, PLUGIN_SESSION_START_REMIND_KEY);
  };
}

function lastSessionStartInjection(
  history: readonly HistoryMessage[],
): LatestInjection | undefined {
  const entry = history.findLast(
    (candidate) =>
      candidate.meta?.source === 'reminder' && candidate.meta?.key === PLUGIN_SESSION_START_REMIND_KEY,
  );
  if (entry === undefined) return undefined;
  return { entry, rendered: systemReminderContent(entry) };
}

const SYSTEM_REMINDER_PREFIX = '<system-reminder>\n';
const SYSTEM_REMINDER_SUFFIX = '\n</system-reminder>';

function systemReminderContent(message: HistoryMessage): string | undefined {
  const text = extractText(message.message);
  if (!text.startsWith(SYSTEM_REMINDER_PREFIX) || !text.endsWith(SYSTEM_REMINDER_SUFFIX)) {
    return undefined;
  }
  return text.slice(SYSTEM_REMINDER_PREFIX.length, text.length - SYSTEM_REMINDER_SUFFIX.length);
}

function frozenSessionStartContent(rendered: string): string | undefined {
  if (rendered === NO_ACTIVE_SESSION_STARTS) return undefined;
  const suffix = `\n\n${SUPERSEDES_SUFFIX}`;
  return rendered.endsWith(suffix) ? rendered.slice(0, -suffix.length) : rendered;
}

function shouldNeutralizePluginSessionStart(history: readonly HistoryMessage[]): boolean {
  return history.some((message) => {
    if (message.meta?.source === 'reminder') {
      return message.meta?.key === PLUGIN_SESSION_START_REMIND_KEY;
    }
    return message.meta?.source === 'compaction';
  });
}

function renderSessionStartBlock(
  sessionStart: EnabledPluginSessionStart,
  skill: SkillDefinition,
  skillContent: string,
): string {
  return (
    `<plugin_session_start plugin="${escapeXmlAttr(sessionStart.pluginId)}" ` +
    `skill="${escapeXmlAttr(skill.name)}">\n${skillContent}\n</plugin_session_start>`
  );
}
