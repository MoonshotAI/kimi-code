import { v4 as randomUUID } from 'uuid';
import type { PromptEnvelopeContent } from '../client/types';

import { computed, getCurrentScope, onScopeDispose, shallowRef, shallowReactive, ref, readonly, watch, watchEffect, type Ref } from 'vue';
import type { BrowserPanelSession } from '@moonshot-ai/app-core/client';
import { panelCloseTargets } from '../panel/panelCloseTargets';
import { reorderedPanelTabs } from '../lib/panelTabDrag';
import { defaultPanelStorage, onPanelBtwDestroyed, onPanelContextDestroyed, onPanelWorkspaceDestroyed, panelContextsOfWorkspace, readPanelSnapshot, removeStoredBtwTab, writePanelSnapshot, type PanelStorage, type StoredPanelSnapshot } from '../panel/panelPersistence';

import type { AppTask } from '@moonshot-ai/app-core/api';
import type { AgentMember, ChatTurn, ConversationProjector, ToolStatus, TurnFileChange } from '@moonshot-ai/app-core/client';
import type { Translator } from '@moonshot-ai/app-core/contracts';
import { createConversationProjector, toAgentMember } from '@moonshot-ai/app-core/client';
import { turnResult } from '@moonshot-ai/app-core/conversation';
import type { ConversationEntry } from './useConversations';
import type { SideChatOpenResult, SideChatTarget } from '../client/useSideChat';
import type { TaskOutputState } from '../client/useTaskOutputStream';
import { sideChatDrafts } from '../client/sideChatDrafts';
import {
  panelRegistry,
  type AgentTabPayload,
  type BrowserTabController,
  type BrowserTabPayload,
  type BtwTabPayload,
  type CompactionTabPayload,
  type DiffTabPayload,
  type FileTabPayload,
  type PanelTabType,
  type TurnDiffTabPayload,
} from '../panel/panelRegistry';
import { clampPanelWidth, panelMaxWidth, useViewportWidth } from './useViewportWidth';

export interface PanelTabPresentation {
  title?: string;
  icon?: string;
  favicon?: string;
  status?: { icon: string; label: string };
}

export interface PanelTab {
  id: string;
  type: PanelTabType;
  title: string;
  payload?: unknown;
  presentation?: PanelTabPresentation;
}

export interface PanelTabsConversations {
  getEntry(sessionId: string, agentId: string): ConversationEntry | undefined;
  activate(sessionId: string, agentId: string): unknown;
  deactivate(sessionId: string, agentId: string): void;
  loadOlder(entry: ConversationEntry): Promise<void>;
}

export interface PanelTabsClient {
  turns: Ref<ChatTurn[]>;
  activeAppTasks: Ref<AppTask[]>;
  activeSessionId: Ref<string | null>;
  activeWorkspaceId: Ref<string | null>;
  auxiliaryConversations: PanelTabsConversations;
  getFileUrl: (fileId: string) => string;
  getSessionMediaUrl: (sessionId: string, fileId: string) => string;
  findBashCommandForTask(task: AppTask): string | undefined;
  loadGitStatus(sessionId: string, options?: { root?: string }): Promise<void>;
  loadFileDiff(path: string, options?: { root?: string; preserveCurrent?: boolean }): Promise<void>;
  clearFileDiff(): void;
  getDraftPromotion(): { workspaceId: string; sessionId: string } | null;
  agentRunningOf?(sessionId: string, agentId: string): boolean;
  watchTaskOutput?(sessionId: string, agentId: string, taskId: string): void;
  unwatchTaskOutput?(sessionId: string, agentId: string, taskId: string): void;
  taskOutputOf?(sessionId: string, agentId: string, taskId: string): TaskOutputState | undefined;
  startSessionAndOpenSideChat(
    workspaceId: string,
    prompt?: string | PromptEnvelopeContent,
  ): Promise<{ sessionId: string; target: SideChatTarget | null; sent: boolean } | null>;
  openSideChatOn(parent: string, prompt?: string | PromptEnvelopeContent): Promise<SideChatOpenResult>;
  closeSideChat(agentId?: string, sessionId?: string): void;
  sideChatTargetsOfSession(sessionId: string): SideChatTarget[];
  restoreSideChatTarget?(sessionId: string, target: SideChatTarget): void;
}

const MAIN_AGENT_ID = 'main';
const PREVIEW_WIDTH_KEY = 'kimi-web.file-preview-width';
export const PREVIEW_MIN = 320;
const MAX_PARKED_BROWSER_TABS = 16;
export function panelDraftContextKey(workspaceId: string): string { return `__draft__:${workspaceId}`; }

let activePanelSessionSnapshotDestroyer: ((sessionId: string) => void) | null = null;
type CloneBrowserTab = (payload: BrowserTabPayload) => Promise<BrowserTabPayload>;
let activePanelSessionForker: ((source: string, target: string, clone: CloneBrowserTab) => Promise<void>) | null = null;

export async function forkPanelBrowserTabs(source: string, target: string, clone: CloneBrowserTab): Promise<void> {
  await activePanelSessionForker?.(source, target, clone);
}

export function destroyPanelSessionSnapshot(sessionId: string): void {
  activePanelSessionSnapshotDestroyer?.(sessionId);
}

export interface UsePanelTabsOptions {
  client: PanelTabsClient;
  sideWidth: Ref<number>;
  t: Translator;
  locale?: Ref<string>;
  onTabRemoved?: (tab: PanelTab) => void;
  storage?: PanelStorage;
  onBrowserSuspended?: (tab: PanelTab) => void;
  browserPersistence?: {
    load(): Promise<BrowserPanelSession[]>;
    save(sessions: BrowserPanelSession[]): Promise<void>;
    onError(error: unknown): void;
  };
}

export function usePanelTabs({ client, sideWidth, t, locale, onTabRemoved, onBrowserSuspended, browserPersistence, storage = defaultPanelStorage() }: UsePanelTabsOptions) {
  const { viewportWidth } = useViewportWidth();

  const previewAreaWidth = computed(() =>
    Math.max(0, viewportWidth.value - sideWidth.value),
  );

  const previewMax = computed(() =>
    panelMaxWidth(previewAreaWidth.value, PREVIEW_MIN, PREVIEW_MIN),
  );

  function clampPreviewWidth(width: number): number {
    return clampPanelWidth(Math.round(width), PREVIEW_MIN, previewMax.value);
  }

  function defaultPreviewWidth(): number {
    return clampPreviewWidth(previewAreaWidth.value / 2);
  }

  const previewDefaultWidth = computed(() => defaultPreviewWidth());
  const previewWidth = ref(PREVIEW_MIN);
  const previewPanelWidth = computed(() =>
    clampPanelWidth(previewWidth.value, PREVIEW_MIN, previewMax.value),
  );

  const panelDragging = ref(false);

  const panelTabs = shallowRef<PanelTab[]>([]);
  const browserTabOpeners = new Map<string, string>();
  const revealedTabId = shallowRef<string | null>(null);
  const activeTabId = ref<string | null>(null);
  const panelVisible = ref(false);
  const panelExpanded = ref(false);

  const panelInteractionVersion = ref(0);

  const activeTab = computed<PanelTab | null>(
    () => panelTabs.value.find((tab) => tab.id === activeTabId.value) ?? null,
  );

  const panelCanExpand = computed(() => activeTab.value !== null && panelRegistry[activeTab.value.type].expandable !== false);
  watch([activeTab, panelExpanded], ([tab, expanded]) => {
    if (tab !== null && expanded && !panelCanExpand.value) panelExpanded.value = false;
  }, { flush: 'sync' });

  const LOCALIZED_TITLE_TYPES: ReadonlySet<PanelTabType> = new Set([
    'agent',
    'diff',
    'files',
    'turn-diff',
    'compaction',
    'btw',
    'term',
    'browser',
    'inspector',
  ]);
  if (locale !== undefined) {
    watch(locale, () => {
      panelTabs.value = panelTabs.value.map((tab) =>
        LOCALIZED_TITLE_TYPES.has(tab.type)
          ? { ...tab, title: tabTitle(tab.type, tab.payload) }
          : tab,
      );
    });
  }

  let nextTabSeq = 0;
  function nextTabId(): string {
    nextTabSeq += 1;
    return `panel-tab-${nextTabSeq}`;
  }

  function tabKey(tab: PanelTab): string | null {
    const def = panelRegistry[tab.type];
    return def.keyOf && tab.payload !== undefined ? def.keyOf(tab.payload) : null;
  }

  function makeTab(type: PanelTabType, payload?: unknown): PanelTab {
    return {
      id: nextTabId(),
      type,
      title: tabTitle(type, payload),
      payload,
    };
  }

  function createTab(type: PanelTabType, payload?: unknown): PanelTab {
    const tab = makeTab(type, payload);
    panelTabs.value = [...panelTabs.value, tab];
    return tab;
  }

  function agentTaskOf(target: string): AppTask | undefined {
    return client.activeAppTasks.value.find((tk) => tk.agentId === target || tk.id === target);
  }

  function agentTaskDescriptionOf(target: string): string | undefined {
    return agentTaskOf(target)?.description || undefined;
  }

  function tabTitle(type: PanelTabType, payload: unknown): string {
    if (type === 'agent' && payload !== undefined) {
      const subagentId = (payload as AgentTabPayload).subagentId;
      const name = agentToolMetadata(subagentId).name ?? agentTaskDescriptionOf(subagentId);
      if (name) return name;
    }
    return panelRegistry[type].title(payload, t);
  }

  let subscribedAgent: { sessionId: string; subagentId: string } | null = null;

  function isShellTab(payload: AgentTabPayload): boolean {
    const task = agentTaskOf(payload.subagentId);
    return task !== undefined ? task.kind === 'bash' : payload.shellTask === true;
  }

  const agentOutputStreamTarget = computed<{ sessionId: string; taskId: string } | null>(() => {
    const active = activeTab.value;
    if (!panelVisible.value || active?.type !== 'agent' || active.payload === undefined) return null;
    const payload = active.payload as AgentTabPayload;
    if (!isShellTab(payload)) return null;
    return { sessionId: payload.sessionId, taskId: payload.subagentId };
  });

  let streamedOutput: { sessionId: string; taskId: string } | null = null;

  function releaseStreamedOutput(): void {
    if (streamedOutput === null) return;
    client.unwatchTaskOutput?.(streamedOutput.sessionId, MAIN_AGENT_ID, streamedOutput.taskId);
    streamedOutput = null;
  }

  watch(
    agentOutputStreamTarget,
    (target) => {
      if (
        streamedOutput !== null &&
        target?.sessionId === streamedOutput.sessionId &&
        target.taskId === streamedOutput.taskId
      ) {
        return;
      }
      releaseStreamedOutput();
      if (target === null) return;
      client.watchTaskOutput?.(target.sessionId, MAIN_AGENT_ID, target.taskId);
      streamedOutput = { sessionId: target.sessionId, taskId: target.taskId };
    },
    { immediate: true },
  );

  function streamedOutputOf(sessionId: string, task: AppTask): TaskOutputState | undefined {
    return client.taskOutputOf?.(sessionId, MAIN_AGENT_ID, task.id);
  }

  function shouldActivateConversation(payload: AgentTabPayload): boolean {
    if (isShellTab(payload)) return false;
    const task = agentTaskOf(payload.subagentId);
    return !task || (task.kind === 'subagent' && task.agentId === payload.subagentId);
  }

  function resolveAgentTarget(target: string): string {
    return agentTaskOf(target)?.agentId ?? target;
  }

  function syncAgentConversation(): void {
    const active = activeTab.value;
    const want =
      panelVisible.value && active?.type === 'agent' && active.payload !== undefined
        ? (active.payload as AgentTabPayload)
        : null;
    const same =
      subscribedAgent !== null &&
      want !== null &&
      subscribedAgent.sessionId === want.sessionId &&
      subscribedAgent.subagentId === want.subagentId;
    if (same && subscribedAgent !== null && shouldActivateConversation(subscribedAgent)) {
      return;
    }
    if (subscribedAgent) {
      client.auxiliaryConversations.deactivate(
        subscribedAgent.sessionId,
        subscribedAgent.subagentId,
      );
      subscribedAgent = null;
    }
    if (want && shouldActivateConversation(want)) {
      client.auxiliaryConversations.activate(want.sessionId, want.subagentId);
      subscribedAgent = { sessionId: want.sessionId, subagentId: want.subagentId };
    }
  }

  watch(
    () => client.activeAppTasks.value,
    () => {
      let changed = false;
      const next = panelTabs.value.map((tab) => {
        if (tab.type !== 'agent' || tab.payload === undefined) return tab;
        const title = tabTitle('agent', tab.payload);
        if (title === tab.title) return tab;
        changed = true;
        return { ...tab, title };
      });
      if (changed) panelTabs.value = next;
      syncAgentConversation();
    },
  );

  function openTab(type: PanelTabType, payload?: unknown): PanelTab {
    const def = panelRegistry[type];
    let tab: PanelTab | undefined;
    if (def.policy === 'singleton') {
      tab = panelTabs.value.find((candidate) => candidate.type === type);
    } else if (def.policy === 'keyed' && payload !== undefined) {
      const key = def.keyOf!(payload);
      tab = panelTabs.value.find(
        (candidate) => candidate.type === type && tabKey(candidate) === key,
      );
    }
    if (tab) {
      if (payload !== undefined && tab.payload !== payload) {
        const refreshed: PanelTab = { ...tab, title: tabTitle(type, payload), payload };
        panelTabs.value = panelTabs.value.map((candidate) =>
          candidate.id === refreshed.id ? refreshed : candidate,
        );
        tab = refreshed;
      }
    } else {
      tab = createTab(type, payload);
    }
    activateTab(tab.id);
    return tab;
  }

  function activateTab(id: string): void {
    if (!panelTabs.value.some((tab) => tab.id === id)) return;
    activeTabId.value = id;
    panelVisible.value = true;
    panelInteractionVersion.value += 1;
    syncAgentConversation();
  }

  function moveTabAfter(id: string, afterId: string): void {
    if (id === afterId) return;
    const tab = panelTabs.value.find(tab => tab.id === id);
    if (!tab || !panelTabs.value.some(tab => tab.id === afterId)) return;
    const rest = panelTabs.value.filter(tab => tab.id !== id);
    rest.splice(rest.findIndex(tab => tab.id === afterId) + 1, 0, tab);
    panelTabs.value = rest;
    panelInteractionVersion.value += 1;
  }

  function renameBrowserTab(id: string, title: string): void {
    const customTitle = title.trim().slice(0, 512) || undefined;
    panelTabs.value = panelTabs.value.map(tab => {
      if (tab.id !== id || tab.type !== 'browser' || tab.payload === undefined) return tab;
      const payload = { ...tab.payload as BrowserTabPayload, customTitle };
      return { ...tab, payload, title: tabTitle('browser', payload) };
    });
  }

  function updateBrowserTabTitle(id: string, title: string): void {
    const normalized = title.trim();
    panelTabs.value = panelTabs.value.map((tab) => {
      if (tab.id !== id || tab.type !== 'browser' || tab.payload === undefined) return tab;
      const payload = tab.payload as BrowserTabPayload;
      const nextTitle = normalized || undefined;
      if (payload.title === nextTitle) return tab;
      const nextPayload: BrowserTabPayload = { ...payload, title: nextTitle };
      return { ...tab, payload: nextPayload, title: tabTitle('browser', nextPayload) };
    });
  }

  function updateBrowserTabLoading(id: string, loading: boolean): void {
    panelTabs.value = panelTabs.value.map((tab) => {
      if (tab.id !== id || tab.type !== 'browser' || tab.payload === undefined) return tab;
      const payload = tab.payload as BrowserTabPayload;
      if ((payload.loading === true) === loading) return tab;
      return { ...tab, payload: { ...payload, loading } satisfies BrowserTabPayload };
    });
  }

  function updateBrowserTabFavicon(id: string, favicon: string | undefined): void {
    panelTabs.value = panelTabs.value.map((tab) => {
      if (tab.id !== id || tab.type !== 'browser' || tab.payload === undefined) return tab;
      const payload = tab.payload as BrowserTabPayload;
      if (payload.favicon === favicon) return tab;
      return { ...tab, payload: { ...payload, favicon } satisfies BrowserTabPayload };
    });
  }

  function addTabInBackground(type: PanelTabType, payload?: unknown): PanelTab {
    const tab = createTab(type, payload);
    if (activeTabId.value === null) {
      activeTabId.value = tab.id;
      panelVisible.value = false;
    }
    return tab;
  }

  function sessionBrowserTabs(sessionId: string): PanelTab[] {
    const tabs = sessionId === panelContextKey.value ? panelTabs.value : snapshotBySession[sessionId]?.tabs ?? [];
    return tabs.filter(tab => tab.type === 'browser');
  }

  function updateSessionBrowserTabs(sessionId: string, update: (tabs: PanelTab[]) => PanelTab[]): void {
    if (sessionId === panelContextKey.value) {
      panelTabs.value = update(panelTabs.value);
    } else {
      const snapshot = snapshotBySession[sessionId];
      if (snapshot !== undefined) snapshotBySession[sessionId] = { ...snapshot, tabs: update(snapshot.tabs) };
    }
  }

  function openedTabIndex(tabs: readonly PanelTab[], openerId: string | undefined): number {
    let index = openerId === undefined ? -1 : tabs.findIndex(tab => tab.id === openerId);
    if (index === -1) return tabs.length;
    while (index + 1 < tabs.length && browserTabOpeners.get(tabs[index + 1]!.id) === openerId) index += 1;
    return index + 1;
  }

  function addSessionBrowserTab(sessionId: string, payload: BrowserTabPayload, openerId?: string): PanelTab {
    if (sessionId === panelContextKey.value) {
      const tab = addTabInBackground('browser', payload);
      const rest = panelTabs.value.filter(candidate => candidate.id !== tab.id);
      const index = openedTabIndex(rest, openerId);
      if (openerId !== undefined) browserTabOpeners.set(tab.id, openerId);
      panelTabs.value = [...rest.slice(0, index), tab, ...rest.slice(index)];
      if (openerId !== undefined) revealedTabId.value = tab.id;
      return tab;
    }
    const tab = { id: nextTabId(), type: 'browser' as const, payload, title: tabTitle('browser', payload) };
    const snapshot = snapshotBySession[sessionId] ?? { tabs: [], activeIndex: null, visible: false, expanded: false };
    const index = openedTabIndex(snapshot.tabs, openerId);
    if (openerId !== undefined) browserTabOpeners.set(tab.id, openerId);
    const activeIndex = snapshot.activeIndex !== null && snapshot.activeIndex >= index ? snapshot.activeIndex + 1 : snapshot.activeIndex;
    snapshotBySession[sessionId] = { ...snapshot, tabs: [...snapshot.tabs.slice(0, index), tab, ...snapshot.tabs.slice(index)], activeIndex };
    touchSnapshot(sessionId);
    trimParkedBrowserTabs(null, tab.id);
    return tab;
  }

  function closeSessionBrowserTab(sessionId: string, id: string, expectedLeaseId?: string): boolean {
    if (expectedLeaseId !== undefined && !sessionBrowserTabs(sessionId).some(tab => tab.id === id && (tab.payload as BrowserTabPayload).controlled?.leaseId === expectedLeaseId)) return false;
    if (sessionId === panelContextKey.value) {
      closeTab(id);
      return true;
    }
    const snapshot = snapshotBySession[sessionId];
    const tab = sessionBrowserTabs(sessionId).find(tab => tab.id === id);
    if (snapshot === undefined || tab === undefined) return false;
    const selected = snapshot.activeIndex === null ? undefined : snapshot.tabs[snapshot.activeIndex];
    const tabs = snapshot.tabs.filter(tab => tab.id !== id);
    const index = selected?.id === id
      ? Math.min(snapshot.activeIndex ?? 0, tabs.length - 1)
      : tabs.findIndex(tab => tab.id === selected?.id);
    snapshotBySession[sessionId] = { ...snapshot, tabs, activeIndex: index < 0 ? null : index };
    onTabRemoved?.(tab);
    return true;
  }

  function controlBrowserTab(sessionId: string, id: string | null, turnId: string, controller?: BrowserTabController): boolean {
    if (id !== null && !sessionBrowserTabs(sessionId).some(tab => tab.id === id)) return false;
    updateSessionBrowserTabs(sessionId, tabs => tabs.map(tab => {
      if (tab.type !== 'browser' || tab.payload === undefined) return tab;
      const payload = tab.payload as BrowserTabPayload;
      const controlled = tab.id === id
        ? { leaseId: randomUUID(), turnId, status: 'running' as const, ...(controller === undefined ? {} : { controller }) }
        : undefined;
      if (controlled !== undefined) suspendedBrowsers.delete(payload.browserId);
      return { ...tab, payload: { ...payload, controlled } };
    }));
    return true;
  }

  function releaseBrowserTab(sessionId: string, id: string, expectedLeaseId: string): boolean {
    const tab = sessionBrowserTabs(sessionId).find(tab => tab.id === id);
    if ((tab?.payload as BrowserTabPayload | undefined)?.controlled?.leaseId !== expectedLeaseId) return false;
    return controlBrowserTab(sessionId, null, '');
  }

  function releaseBrowserRun(sessionId: string, run: { agentId: string; generation: number; turnId: number }): void {
    let released = false;
    updateSessionBrowserTabs(sessionId, tabs => tabs.map(tab => {
      if (tab.type !== 'browser' || tab.payload === undefined) return tab;
      const payload = tab.payload as BrowserTabPayload;
      const current = payload.controlled?.controller?.run;
      if (current === undefined || current.agentId !== run.agentId || current.generation !== run.generation || current.turnId !== run.turnId) return tab;
      released = true;
      return { ...tab, payload: { ...payload, controlled: undefined } };
    }));
    if (released) trimParkedBrowserTabs();
  }

  function releaseBrowserMainControl(sessionId: string): void {
    let released = false;
    updateSessionBrowserTabs(sessionId, tabs => tabs.map(tab => {
      if (tab.type !== 'browser' || tab.payload === undefined) return tab;
      const payload = tab.payload as BrowserTabPayload;
      if (payload.controlled === undefined || payload.controlled.controller !== undefined) return tab;
      released = true;
      return { ...tab, payload: { ...payload, controlled: undefined } };
    }));
    if (released) trimParkedBrowserTabs();
  }

  function browserTabOwner(browserId: string): { sessionId: string; tabId: string } | null {
    const sessions = new Set(Object.keys(snapshotBySession));
    sessions.add(panelContextKey.value);
    for (const sessionId of sessions) {
      const tab = sessionBrowserTabs(sessionId).find(tab => (tab.payload as BrowserTabPayload | undefined)?.browserId === browserId);
      if (tab) return { sessionId, tabId: tab.id };
    }
    return null;
  }

  function isBrowserSessionControlled(sessionId: string): boolean {
    return sessionBrowserTabs(sessionId).some(tab => (tab.payload as BrowserTabPayload).controlled !== undefined);
  }

  function controlledBrowserSessions(): string[] {
    const sessions = new Set(Object.keys(snapshotBySession));
    if (client.activeSessionId.value !== null) sessions.add(client.activeSessionId.value);
    return [...sessions].filter(isBrowserSessionControlled);
  }

  function syncBrowserControls(getState: (sessionId: string) => {
    turnId: string | null; status: 'running' | 'paused' | 'unknown' | 'idle';
  }): void {
    const sessions = new Set(Object.keys(snapshotBySession));
    if (client.activeSessionId.value !== null) sessions.add(client.activeSessionId.value);
    let released = false;
    for (const sessionId of sessions) {
      const controls = sessionBrowserTabs(sessionId).filter(tab => (tab.payload as BrowserTabPayload).controlled !== undefined);
      if (controls.length === 0) continue;
      const state = getState(sessionId);
      for (const tab of controls) {
        const payload = tab.payload as BrowserTabPayload;
        const control = payload.controlled!;
        if (control.controller !== undefined) continue;
        const ended = state.status !== 'unknown' && (state.status === 'idle' || state.turnId !== control.turnId);
        if (!ended && control.status === state.status) continue;
        const controlled = ended ? undefined : { ...control, status: state.status as 'running' | 'paused' | 'unknown' };
        released ||= ended;
        updateSessionBrowserTabs(sessionId, tabs => tabs.map(candidate => candidate.id === tab.id
          ? { ...candidate, payload: { ...payload, controlled } } : candidate));
      }
    }
    if (released) trimParkedBrowserTabs();
  }

  function closeTab(id: string, options: { keepVisible?: boolean; skipSideChatClose?: boolean } = {}): void {
    const index = panelTabs.value.findIndex((tab) => tab.id === id);
    if (index === -1) return;
    const tab = panelTabs.value[index]!;
    if (tab.type === 'btw' && tab.payload !== undefined && !options.skipSideChatClose) {
      const payload = tab.payload as BtwTabPayload;
      client.closeSideChat(payload.agentId, payload.parentId);
    } else if (tab.type === 'diff') {
      resetDiffState();
      client.clearFileDiff();
    }
    panelTabs.value = panelTabs.value.filter((candidate) => candidate.id !== id);
    if (activeTabId.value === id) {
      const next = panelTabs.value[Math.min(index, panelTabs.value.length - 1)];
      activeTabId.value = next?.id ?? null;
    }
    if (panelTabs.value.length === 0 && !options.keepVisible) {
      panelVisible.value = false;
      panelExpanded.value = false;
    }
    panelInteractionVersion.value += 1;
    onTabRemoved?.(tab);
    syncAgentConversation();
  }

  function cycleTab(direction: 1 | -1): boolean {
    if (!panelVisible.value || panelTabs.value.length < 2) return false;
    const index = panelTabs.value.findIndex(tab => tab.id === activeTabId.value);
    const next = (index + direction + panelTabs.value.length) % panelTabs.value.length;
    activateTab(panelTabs.value[next]!.id);
    return true;
  }

  function moveTab(id: string, index: number): void {
    const next = reorderedPanelTabs(panelTabs.value, id, index);
    if (next === null) return;
    panelTabs.value = next;
    panelInteractionVersion.value += 1;
  }

  function closeOtherTabs(id: string): void {
    for (const tab of panelCloseTargets(panelTabs.value, 'others', id)) closeTab(tab.id);
  }

  function closeTabsToRight(id: string): void {
    for (const tab of panelCloseTargets(panelTabs.value, 'right', id)) closeTab(tab.id);
  }

  function closeAllTabs(): void {
    for (const tab of panelCloseTargets(panelTabs.value, 'all')) closeTab(tab.id);
  }

  function hidePanel(): boolean {
    if (!panelVisible.value) return false;
    panelVisible.value = false;
    panelExpanded.value = false;
    panelInteractionVersion.value += 1;
    syncAgentConversation();
    return true;
  }

  function showPanel(): void {
    panelVisible.value = true;
    panelInteractionVersion.value += 1;
    syncAgentConversation();
  }

  function toggleExpanded(): void {
    if (!panelCanExpand.value) return;
    panelExpanded.value = !panelExpanded.value;
    if (panelExpanded.value) panelVisible.value = true;
    panelInteractionVersion.value += 1;
  }

  function leaveChatView(): void {
    panelExpanded.value = false;
    panelInteractionVersion.value += 1;
  }

  function bumpInteractionVersion(): void {
    panelInteractionVersion.value += 1;
  }

  function compactionPanelTextOf(turnId: string): string | null {
    const turn = client.turns.value.find((tn) => tn.id === turnId);
    if (turn?.role === 'compaction' && turn.text) return turn.text;
    const tab = panelTabs.value.find(tab => tab.type === 'compaction' && (tab.payload as CompactionTabPayload).turnId === turnId);
    return (tab?.payload as CompactionTabPayload | undefined)?.text ?? null;
  }

  function isCompactionPanelOpen(turnId: string): boolean {
    const active = activeTab.value;
    return (
      panelVisible.value &&
      active?.type === 'compaction' &&
      (active.payload as CompactionTabPayload | undefined)?.turnId === turnId
    );
  }

  function openCompactionPanel(target: { turnId: string }): void {
    openTab('compaction', { turnId: target.turnId, text: compactionPanelTextOf(target.turnId) ?? undefined } satisfies CompactionTabPayload);
  }

  function toggleCompactionPanel(target: { turnId: string }): void {
    if (isCompactionPanelOpen(target.turnId)) {
      hidePanel();
      return;
    }
    openCompactionPanel(target);
  }

  function agentConversationStateOf(target: AgentTabPayload): {
    entry: ConversationEntry | undefined;
    version: number;
  } {
    const entry = client.auxiliaryConversations.getEntry(target.sessionId, target.subagentId);
    return { entry, version: entry?.version.value ?? 0 };
  }

  function agentToolMetadata(agentId: string): {
    name?: string;
    subagentType?: string;
    prompt?: string;
    model?: string;
    thinking?: string;
    status?: ToolStatus;
    outputLines?: string[];
  } {
    const tool = client.turns.value
      .flatMap((turn) => turn.tools ?? [])
      .find((item) => item.agentId === agentId);
    if (!tool) return {};
    try {
      const input = JSON.parse(tool.arg) as Record<string, unknown>;
      return {
        name: typeof input['description'] === 'string' ? input['description'] : undefined,
        subagentType:
          typeof input['subagent_type'] === 'string' ? input['subagent_type'] : undefined,
        prompt: typeof input['prompt'] === 'string' ? input['prompt'] : undefined,
        model: typeof input['model'] === 'string' ? input['model'] : undefined,
        thinking: typeof input['thinking'] === 'string' ? input['thinking'] : undefined,
        status: tool.status,
        outputLines: tool.output,
      };
    } catch {
      return {};
    }
  }

  function subagentPanelPrompt(
    entry: ConversationEntry | undefined,
    fallbackPrompt: string | undefined,
  ): string | undefined {
    if (entry === undefined || !entry.loaded || entry.view.hasMore) return fallbackPrompt;
    const opener = entry.view.turns.find((turn) => turn.kind === 'agent')?.items[0];
    if (opener?.type !== 'user_message' || opener.text.length === 0) return fallbackPrompt;
    return opener.text;
  }

  function agentPanelMemberOf(target: AgentTabPayload): AgentMember | null {
    const resolvedTarget: AgentTabPayload = {
      ...target,
      subagentId: resolveAgentTarget(target.subagentId),
    };
    const { entry, version } = agentConversationStateOf(resolvedTarget);
    void version;
    const task = agentTaskOf(target.subagentId);
    if (task) {
      const member = toAgentMember(task, client.findBashCommandForTask(task));
      const output = task.kind === 'bash' ? streamedOutputOf(target.sessionId, task) : undefined;
      if (output !== undefined) {
        member.outputLoading = output.status === 'loading';
        member.outputUnavailable = output.status === 'failed';
        if (output.status === 'ready') member.outputLines = output.text.split(/\r?\n/);
      }
      if (task.kind === 'subagent') {
        const toolMetadata = agentToolMetadata(member.id);
        member.prompt ??= subagentPanelPrompt(entry, toolMetadata.prompt);
        member.model ??= toolMetadata.model;
        member.thinkingEffort ??= toolMetadata.thinking;
      }
      return member;
    }
    if (target.shellTask === true) {
      const output = client.taskOutputOf?.(target.sessionId, MAIN_AGENT_ID, target.subagentId);
      return {
        id: target.subagentId,
        kind: 'bash',
        name: '',
        phase: 'completed',
        status: 'completed',
        outputLoading: output === undefined || output.status === 'loading',
        outputUnavailable: output?.status === 'failed',
        outputLines: output?.status === 'ready' ? output.text.split(/\r?\n/) : undefined,
      };
    }

    const failed = entry?.loadError !== undefined;
    const loading = entry === undefined || (!entry.loaded && !failed);
    const running = client.agentRunningOf?.(target.sessionId, target.subagentId) ?? false;
    const toolMetadata = agentToolMetadata(target.subagentId);
    const lastTurn = entry?.view.turns.at(-1);
    const lastResult = lastTurn === undefined ? undefined : turnResult(lastTurn);
    const cancelled = lastResult === 'cancelled';
    const terminalFailed = lastResult === 'failed' || toolMetadata.status === 'error';
    const loadFailed = failed && toolMetadata.status === undefined;
    const phase = running
      ? 'working'
      : cancelled
        ? 'cancelled'
        : terminalFailed || loadFailed
          ? 'failed'
          : loading
            ? 'queued'
            : 'completed';
    const status = running
      ? 'running'
      : cancelled
        ? 'cancelled'
        : terminalFailed || loadFailed
          ? 'failed'
          : loading
            ? 'running'
            : 'completed';
    return {
      id: target.subagentId,
      kind: 'subagent',
      name: toolMetadata.name ?? target.subagentId,
      subagentType: toolMetadata.subagentType,
      model: toolMetadata.model,
      thinkingEffort: toolMetadata.thinking,
      prompt: subagentPanelPrompt(entry, toolMetadata.prompt),
      phase,
      status,
      outputLines: toolMetadata.outputLines,
    };
  }

  const agentProjectors = new WeakMap<ConversationEntry, ConversationProjector>();

  function agentPanelTurnsOf(target: AgentTabPayload): ChatTurn[] {
    const { entry } = agentConversationStateOf(target);
    if (!entry) return [];
    let projector = agentProjectors.get(entry);
    if (projector === undefined) {
      projector = createConversationProjector();
      agentProjectors.set(entry, projector);
    }
    return projector(entry.view.turns, {
      sessionId: target.sessionId,
      getFileUrl: client.getFileUrl,
      getSessionMediaUrl: client.getSessionMediaUrl,
    });
  }

  const agentPanelLoadingOf = (target: AgentTabPayload): boolean => {
    const { entry } = agentConversationStateOf(target);
    return entry !== undefined && !entry.loaded && entry.loadError === undefined;
  };
  const agentPanelLoadErrorOf = (target: AgentTabPayload): boolean =>
    agentConversationStateOf(target).entry?.loadError !== undefined;
  const agentPanelLoadingMoreOf = (target: AgentTabPayload): boolean =>
    agentConversationStateOf(target).entry?.loadingOlder ?? false;
  const agentPanelLoadMoreErrorOf = (target: AgentTabPayload): boolean =>
    agentConversationStateOf(target).entry?.loadOlderError ?? false;
  const agentPanelHasMoreOf = (target: AgentTabPayload): boolean =>
    agentConversationStateOf(target).entry?.view.hasMore ?? false;
  const agentPanelRunningOf = (target: AgentTabPayload): boolean =>
    client.agentRunningOf?.(target.sessionId, target.subagentId) ?? false;

  function loadOlderAgentMessages(target: AgentTabPayload): void {
    const entry = agentConversationStateOf(target).entry;
    if (entry) void client.auxiliaryConversations.loadOlder(entry);
  }

  function openAgentPanel(target: string): void {
    const sessionId = client.activeSessionId.value;
    if (!target || !sessionId) return;
    const resolved = resolveAgentTarget(target);
    const shellTask = agentTaskOf(target)?.kind === 'bash' || undefined;
    openTab('agent', { sessionId, subagentId: resolved, shellTask } satisfies AgentTabPayload);
  }

  const detailDiffMode = ref<'list' | 'detail'>('list');
  const detailDiffPath = ref<string | null>(null);
  const diffStatusTarget = computed(() => {
    const tab = activeTab.value;
    const sessionId = client.activeSessionId.value;
    if (!panelVisible.value || tab?.type !== 'diff' || sessionId === null) return null;
    return { sessionId, root: (tab.payload as DiffTabPayload | undefined)?.root };
  });
  watch(diffStatusTarget, (target) => {
    if (target === null) return;
    if (target.root === undefined) void client.loadGitStatus(target.sessionId);
    else void client.loadGitStatus(target.sessionId, { root: target.root });
  }, { immediate: true, flush: 'sync' });

  function resetDiffState(): void {
    detailDiffMode.value = 'list';
    detailDiffPath.value = null;
  }

  function openDiffDetail(root?: string): void {
    const existing = panelTabs.value.find((tab) => tab.type === 'diff');
    const currentRoot = (existing?.payload as DiffTabPayload | undefined)?.root;
    if (!existing || currentRoot !== root) {
      resetDiffState();
      if (existing) client.clearFileDiff();
    }
    openTab('diff', root === undefined ? {} : { root } satisfies DiffTabPayload);
  }

  function closeDiffDetail(): void {
    const tab = panelTabs.value.find((candidate) => candidate.type === 'diff');
    if (tab) closeTab(tab.id);
  }

  async function selectDiffFile(path: string, root?: string): Promise<void> {
    detailDiffMode.value = 'detail';
    detailDiffPath.value = path;
    if (root === undefined) await client.loadFileDiff(path);
    else await client.loadFileDiff(path, { root });
  }

  function openTurnDiff(target: {
    turnId: string;
    daemonTurnId?: number;
    sessionId?: string;
    cwd?: string;
    change: TurnFileChange;
  }): void {
    const source = client.turns.value.find((candidate) => candidate.id === target.turnId);
    const sessionId = target.sessionId ?? source?.sessionId;
    target = {
      turnId: target.turnId,
      daemonTurnId: target.daemonTurnId,
      sessionId,
      cwd: target.cwd,
      change: target.change,
    };
    const active = activeTab.value;
    const activePayload =
      active?.type === 'turn-diff' ? (active.payload as TurnDiffTabPayload | undefined) : undefined;
    if (
      panelVisible.value &&
      active != null &&
      activePayload !== undefined &&
      activePayload.sessionId === target.sessionId &&
      activePayload.turnId === target.turnId &&
      activePayload.change.path === target.change.path
    ) {
      closeTab(active.id);
      return;
    }
    openTab('turn-diff', {
      turnId: target.turnId,
      daemonTurnId: target.daemonTurnId,
      sessionId: target.sessionId,
      cwd: target.cwd,
      change: target.change,
    } satisfies TurnDiffTabPayload);
  }

  function openFilePreview(target: FileTabPayload): void {
    openTab('file', { ...target });
  }

  function openFilesPanel(): PanelTab {
    return openTab('files');
  }

  async function openSideChatTab(prompt?: string | PromptEnvelopeContent): Promise<{ sessionId: string | null; agentId: string | null; sent: boolean }> {
    const interactionAtCall = panelInteractionVersion.value;
    const workspaceAtCall = client.activeWorkspaceId.value;
    const present = (target: SideChatTarget, parentId: string): void => {
      const payload = {
        parentId,
        agentId: target.agentId,
        seq: target.seq,
      } satisfies BtwTabPayload;
      if (panelInteractionVersion.value === interactionAtCall) openTab('btw', payload);
      else addTabInBackground('btw', payload);
    };
    if (!client.activeSessionId.value && client.activeWorkspaceId.value) {
      const created = await client.startSessionAndOpenSideChat(
        client.activeWorkspaceId.value,
        prompt,
      );
      if (!created) return { sessionId: null, agentId: null, sent: false };
      const createdId = created.sessionId;
      if (client.activeSessionId.value !== createdId) {
        if (created.target) {
          snapshotBtwFor(createdId, {
            parentId: createdId,
            agentId: created.target.agentId,
            seq: created.target.seq,
          }, workspaceAtCall);
        }
        return { sessionId: createdId, agentId: created.target?.agentId ?? null, sent: created.sent };
      }
      if (created.target) present(created.target, createdId);
      return { sessionId: createdId, agentId: created.target?.agentId ?? null, sent: created.sent };
    }
    const parent = client.activeSessionId.value;
    if (!parent) return { sessionId: null, agentId: null, sent: false };
    const result = await client.openSideChatOn(parent, prompt);
    if (result.target && !result.sent && typeof prompt === 'string' && prompt) {
      sideChatDrafts.set(result.target.agentId, prompt);
    }
    if (result.target && client.activeSessionId.value !== parent) {
      snapshotBtwFor(parent, { parentId: parent, agentId: result.target.agentId, seq: result.target.seq }, workspaceAtCall);
      return { sessionId: parent, agentId: result.target.agentId, sent: result.sent };
    }
    if (result.target) present(result.target, parent);
    return { sessionId: parent, agentId: result.target?.agentId ?? null, sent: result.sent };
  }

  function snapshotBtwFor(sessionId: string, payload: BtwTabPayload, workspaceId: string | null): void {
    if (destroyedContexts.has(sessionId)) return;
    const snap = snapshotBySession[sessionId] ?? { tabs: [], activeIndex: null, visible: false, expanded: false };
    snap.workspaceId = workspaceId;
    snap.tabs = [
      ...snap.tabs.filter(
        (entry) =>
          !(entry.type === 'btw' && (entry.payload as BtwTabPayload).agentId === payload.agentId),
      ),
      makeTab('btw', payload),
    ];
    snapshotBySession[sessionId] = snap;
    writePanelSnapshot(storage, sessionId, snap);
    touchSnapshot(sessionId);
    trimParkedBrowserTabs();
  }

  interface PanelSnapshot {
    workspaceId?: string | null;
    tabs: PanelTab[];
    activeIndex: number | null;
    visible: boolean;
    expanded: boolean;
  }

  const snapshotBySession = shallowReactive<Record<string, PanelSnapshot>>({});
  const destroyedContexts = new Set<string>();
  const snapshotOrder: string[] = [];
  const suspendedBrowsers = new Set<string>();
    const destroyedBeforeLoad = new Set<string>();

  function touchSnapshot(sessionId: string): void {
    const index = snapshotOrder.indexOf(sessionId);
    if (index !== -1) snapshotOrder.splice(index, 1);
    snapshotOrder.push(sessionId);
  }

  function discardSnapshot(sessionId: string, releaseResources: boolean): void {
    const snapshot = snapshotBySession[sessionId];
    delete snapshotBySession[sessionId];
    const index = snapshotOrder.indexOf(sessionId);
    if (index !== -1) snapshotOrder.splice(index, 1);
    if (!releaseResources || snapshot === undefined) return;
    for (const tab of snapshot.tabs) onTabRemoved?.(tab);
  }

  function trimParkedBrowserTabs(protectedSessionId?: string | null, protectedTabId?: string): void {
    let count = Object.entries(snapshotBySession).reduce(
      (sum, [id, snapshot]) => sum + (id === protectedSessionId || id === panelContextKey.value ? 0 : snapshot.tabs.filter((tab) => tab.type === 'browser' && !suspendedBrowsers.has((tab.payload as BrowserTabPayload).browserId)).length),
      0,
    );
    const reclaimable = (tab: PanelTab): boolean => tab.type === 'browser' && tab.id !== protectedTabId &&
      !suspendedBrowsers.has((tab.payload as BrowserTabPayload).browserId) &&
      (tab.payload as BrowserTabPayload).controlled === undefined;
    while (count > MAX_PARKED_BROWSER_TABS) {
      const sessionId = snapshotOrder.find((id) =>
        id !== protectedSessionId && id !== panelContextKey.value && snapshotBySession[id]?.tabs.some(reclaimable),
      );
      if (sessionId === undefined) break;
      const snapshot = snapshotBySession[sessionId];
      if (snapshot === undefined) break;
      const index = snapshot.tabs.findIndex(reclaimable);
      if (index === -1) break;
      if (onBrowserSuspended !== undefined) {
        const tab = snapshot.tabs[index]!;
        suspendedBrowsers.add((tab.payload as BrowserTabPayload).browserId);
        onBrowserSuspended(tab);
        count -= 1;
        continue;
      }
      const [tab] = snapshot.tabs.splice(index, 1);
      if (snapshot.activeIndex === index) snapshot.activeIndex = null;
      else if (snapshot.activeIndex !== null && snapshot.activeIndex > index) {
        snapshot.activeIndex -= 1;
      }
      if (tab !== undefined) onTabRemoved?.(tab);
      count -= 1;
      if (snapshot.tabs.length === 0) discardSnapshot(sessionId, false);
    }
  }

  function destroySessionSnapshot(sessionId: string): void {
    destroyContext(sessionId);
  }

  activePanelSessionSnapshotDestroyer = destroySessionSnapshot;
  async function forkBrowserTabs(source: string, target: string, clone: CloneBrowserTab): Promise<void> {
    const sourceSnapshot = source === client.activeSessionId.value
      ? {
          tabs: [...panelTabs.value],
          activeIndex: panelTabs.value.findIndex((tab) => tab.id === activeTabId.value),
          visible: panelVisible.value,
        }
      : snapshotBySession[source];
    if (sourceSnapshot === undefined || source === target) return;
    const cloned: PanelTab[] = [];
    let clonedActiveIndex: number | null = null;
    try {
      for (const [index, tab] of sourceSnapshot.tabs.entries()) {
        if (tab.type !== 'browser' || tab.payload === undefined) continue;
        const payload = { ...await clone({ ...tab.payload as BrowserTabPayload }), controlled: undefined };
        if (index === sourceSnapshot.activeIndex) clonedActiveIndex = cloned.length;
        cloned.push({ id: nextTabId(), type: 'browser', payload, title: tabTitle('browser', payload) });
      }
    } catch (error) {
      for (const tab of cloned) onTabRemoved?.(tab);
      throw error;
    }
    if (cloned.length === 0) return;
    discardSnapshot(target, true);
    snapshotBySession[target] = {
      tabs: cloned,
      activeIndex: clonedActiveIndex,
      visible: sourceSnapshot.visible && clonedActiveIndex !== null,
      expanded: false,
    };
    touchSnapshot(target);
    trimParkedBrowserTabs(target);
    if (client.activeSessionId.value === target) restoreSnapshot(target);
  }
  activePanelSessionForker = forkBrowserTabs;
  if (getCurrentScope() !== undefined) {
    onScopeDispose(() => {
      releaseStreamedOutput();
      if (activePanelSessionSnapshotDestroyer === destroySessionSnapshot) {
        activePanelSessionSnapshotDestroyer = null;
      }
      if (activePanelSessionForker === forkBrowserTabs) activePanelSessionForker = null;
    });
  }

  function captureSnapshot(sessionId: string, enteringId?: string | null): void {
    if (destroyedContexts.has(sessionId)) return;
    const restorable = panelTabs.value.filter(
      (tab) => panelRegistry[tab.type].restorable,
    );
    if (restorable.length === 0 && !panelVisible.value) {
      discardSnapshot(sessionId, false);
      writePanelSnapshot(storage, sessionId, { tabs: [], activeIndex: null, visible: false, expanded: false });
      return;
    }
    const activeIndex = restorable.findIndex((tab) => tab.id === activeTabId.value);
    snapshotBySession[sessionId] = {
      workspaceId: displayedWorkspaceId,
      tabs: restorable.map(tab => ({ ...tab })),
      activeIndex: activeIndex === -1 ? null : activeIndex,
      visible: panelVisible.value,
      expanded: panelExpanded.value,
    };
    writePanelSnapshot(storage, sessionId, snapshotBySession[sessionId]!);
    touchSnapshot(sessionId);
    trimParkedBrowserTabs(enteringId);
  }

  function hydrateStoredSnapshot(sessionId: string, stored: StoredPanelSnapshot): PanelSnapshot {
    const snapshot = { ...stored, tabs: stored.tabs.map(tab => ({ ...tab, id: nextTabId(), title: tabTitle(tab.type, tab.payload) })) };
    for (const tab of snapshot.tabs) {
      if (tab.type !== 'btw') continue;
      const payload = tab.payload as BtwTabPayload;
      client.restoreSideChatTarget?.(sessionId, { agentId: payload.agentId, seq: payload.seq });
    }
    return snapshot;
  }

  let nativeBrowserLayoutLoaded = false;

  function withNativeBrowserTabs(snapshot: PanelSnapshot, native: readonly PanelTab[], activeBrowserId: string | null): PanelSnapshot {
    const browserIdOf = (tab: PanelTab): string => (tab.payload as BrowserTabPayload).browserId;
    const nativeByBrowserId = new Map(native.map(tab => [browserIdOf(tab), tab]));
    const active = snapshot.activeIndex === null ? undefined : snapshot.tabs[snapshot.activeIndex];
    const used = new Set<string>();
    const tabs: PanelTab[] = [];
    for (const tab of snapshot.tabs) {
      if (tab.type !== 'browser') {
        tabs.push(tab);
        continue;
      }
      const current = nativeByBrowserId.get(browserIdOf(tab));
      if (current === undefined || used.has(browserIdOf(tab))) continue;
      used.add(browserIdOf(tab));
      tabs.push(current);
    }
    for (const tab of native) if (!used.has(browserIdOf(tab))) tabs.push(tab);
    const activeTab = active?.type === 'browser' ? nativeByBrowserId.get(browserIdOf(active)) : active;
    let activeIndex = activeTab === undefined ? -1 : tabs.indexOf(activeTab);
    if (activeIndex < 0 && activeBrowserId !== null) {
      activeIndex = tabs.findIndex(tab => tab.type === 'browser' && browserIdOf(tab) === activeBrowserId);
    }
    return { ...snapshot, tabs, activeIndex: activeIndex < 0 ? null : activeIndex, visible: activeIndex >= 0 && snapshot.visible };
  }

  function restoreSnapshot(sessionId: string): void {
    let snap = snapshotBySession[sessionId];
    const stored = snap === undefined ? readPanelSnapshot(storage, sessionId) : undefined;
    if (stored !== undefined) {
      snap = hydrateStoredSnapshot(sessionId, stored);
      if (nativeBrowserLayoutLoaded) snap = withNativeBrowserTabs(snap, [], null);
    }
    if (!snap) return;
    discardSnapshot(sessionId, false);
    const liveSideTargets = client.sideChatTargetsOfSession(sessionId);
    let restoredActiveId: string | null = null;
    const survivorByKey = new Map<string, string>();
    snap.tabs.forEach((entry, index) => {
      let payload = entry.payload;
      if (entry.type === 'agent') {
        const p = payload as AgentTabPayload;
        payload = { sessionId, subagentId: resolveAgentTarget(p.subagentId), shellTask: p.shellTask };
      } else if (entry.type === 'btw') {
        const p = payload as BtwTabPayload;
        if (!liveSideTargets.some((target) => target.agentId === p.agentId)) return;
      }
      const keyOf = panelRegistry[entry.type].keyOf;
      const dedupKey = keyOf !== undefined && payload !== undefined ? `${entry.type}:${keyOf(payload)}` : null;
      if (dedupKey !== null) {
        const survivor = survivorByKey.get(dedupKey);
        if (survivor !== undefined) {
          if (snap.activeIndex === index) restoredActiveId = survivor;
          return;
        }
      }
      const tab = createTab(entry.type, payload);
      tab.id = entry.id;
      tab.presentation = entry.presentation;
      if (entry.type === 'browser') suspendedBrowsers.delete((payload as BrowserTabPayload).browserId);
      if (dedupKey !== null) survivorByKey.set(dedupKey, tab.id);
      if (snap.activeIndex === index) restoredActiveId = tab.id;
    });
    if (panelTabs.value.length === 0) {
      panelVisible.value = snap.tabs.length === 0 && snap.visible;
      panelExpanded.value = panelVisible.value && snap.expanded;
      return;
    }
    activeTabId.value = restoredActiveId ?? panelTabs.value.at(-1)!.id;
    panelVisible.value = snap.visible;
    panelExpanded.value = panelVisible.value && snap.expanded;
    syncAgentConversation();
  }

  const DRAFT_CONTEXT_PREFIX = '__draft__:';
  const panelContextKey = computed(() => {
    const sessionId = client.activeSessionId.value;
    return sessionId || panelDraftContextKey(client.activeWorkspaceId.value ?? 'none');
  });

  let displayedContextKey = panelContextKey.value;
  let displayedWorkspaceId = client.activeWorkspaceId.value;
  watch(panelContextKey, (newKey, oldKey) => {
    const leavingId = oldKey.startsWith(DRAFT_CONTEXT_PREFIX) ? null : oldKey;
    const enteringId = newKey.startsWith(DRAFT_CONTEXT_PREFIX) ? null : newKey;

    const promotionRecord = client.getDraftPromotion();
    const leavingWorkspaceId = oldKey.startsWith(DRAFT_CONTEXT_PREFIX)
      ? oldKey.slice(DRAFT_CONTEXT_PREFIX.length)
      : null;
    const promotion =
      !leavingId &&
      enteringId !== null &&
      promotionRecord !== null &&
      promotionRecord.sessionId === enteringId &&
      promotionRecord.workspaceId === leavingWorkspaceId;
    if (!promotion) captureSnapshot(oldKey, newKey);
    else {
      delete snapshotBySession[oldKey];
      writePanelSnapshot(storage, oldKey, { tabs: [], activeIndex: null, visible: false, expanded: false });
    }
    if (!promotion) panelInteractionVersion.value += 1;
    const surviving = promotion
      ? panelTabs.value
      : [];
    for (const tab of panelTabs.value) {
      if (surviving.includes(tab) || panelRegistry[tab.type].restorable) continue;
      onTabRemoved?.(tab);
    }
    panelTabs.value = surviving;
    if (surviving.length === 0) {
      activeTabId.value = null;
      panelVisible.value = false;
      panelExpanded.value = false;
    } else if (!surviving.some((tab) => tab.id === activeTabId.value)) {
      activeTabId.value = surviving.at(-1)!.id;
    }
    resetDiffState();
    client.clearFileDiff();
    syncAgentConversation();
    destroyedContexts.delete(newKey);
    if (!promotion) restoreSnapshot(newKey);
    displayedContextKey = newKey;
    displayedWorkspaceId = client.activeWorkspaceId.value;
  });

  const persistenceLoaded = ref(browserPersistence === undefined);
  const browserPersistenceReady = browserPersistence === undefined ? Promise.resolve() : browserPersistence.load().then(sessions => {
    for (const session of sessions) {
      if (destroyedBeforeLoad.has(session.sessionId)) {
        for (const payload of session.tabs) onTabRemoved?.(makeTab('browser', payload));
        continue;
      }
      const tabs = session.tabs.map(payload => ({ id: nextTabId(), type: 'browser' as const, payload, title: tabTitle('browser', payload) }));
      const index = session.tabs.findIndex(tab => tab.browserId === session.activeBrowserId);
      const stored = readPanelSnapshot(storage, session.sessionId);
      snapshotBySession[session.sessionId] = stored !== undefined
        ? withNativeBrowserTabs(hydrateStoredSnapshot(session.sessionId, stored), tabs, session.activeBrowserId)
        : { tabs, activeIndex: index < 0 ? null : index, visible: session.visible && index >= 0, expanded: false };
      for (const tab of tabs) {
        suspendedBrowsers.add((tab.payload as BrowserTabPayload).browserId);
        onBrowserSuspended?.(tab);
      }
      touchSnapshot(session.sessionId);
    }
    nativeBrowserLayoutLoaded = true;
    const key = panelContextKey.value;
    if (panelTabs.value.length === 0) restoreSnapshot(key);
    else {
      const restored = snapshotBySession[key];
      for (const tab of restored?.tabs ?? []) {
        if (tab.type !== 'browser') continue;
        const payload = tab.payload as BrowserTabPayload;
        if (panelTabs.value.some(current => current.type === 'browser' && (current.payload as BrowserTabPayload).browserId === payload.browserId)) continue;
        addTabInBackground('browser', payload);
        suspendedBrowsers.delete(payload.browserId);
      }
      discardSnapshot(key, false);
    }
    persistenceLoaded.value = true;
  }).catch(error => browserPersistence.onError(error)).finally(() => { destroyedBeforeLoad.clear(); persistenceLoaded.value = true; });

  watchEffect(() => {
    if (browserPersistence === undefined || !persistenceLoaded.value) return;
    const snapshots = new Map(Object.entries(snapshotBySession));
    snapshots.set(panelContextKey.value, {
      expanded: panelExpanded.value,
      tabs: panelTabs.value,
      activeIndex: panelTabs.value.findIndex(tab => tab.id === activeTabId.value),
      visible: panelVisible.value,
    });
    const sessions: BrowserPanelSession[] = [];
    for (const [sessionId, snapshot] of snapshots) {
      const tabs = snapshot.tabs.filter(tab => tab.type === 'browser').map(tab => {
        const payload = tab.payload as BrowserTabPayload;
        return { browserId: payload.browserId, ...(payload.title === undefined ? {} : { title: payload.title }), ...(payload.customTitle === undefined ? {} : { customTitle: payload.customTitle }) };
      });
      if (tabs.length === 0) continue;
      const active = snapshot.activeIndex === null ? undefined : snapshot.tabs[snapshot.activeIndex];
      sessions.push({ sessionId, tabs, activeBrowserId: active?.type === 'browser' ? (active.payload as BrowserTabPayload).browserId : null, visible: snapshot.visible });
    }
    void browserPersistence.save(sessions).catch(error => browserPersistence.onError(error));
  }, { flush: 'post' });

  function destroyContext(key: string): void {
    destroyedContexts.add(key);
    if (!persistenceLoaded.value) destroyedBeforeLoad.add(key);
    const tabs = new Map((snapshotBySession[key]?.tabs ?? []).map(tab => [tab.id, tab]));
    if (displayedContextKey === key) for (const tab of panelTabs.value) tabs.set(tab.id, tab);
    for (const tab of tabs.values()) onTabRemoved?.(tab);
    discardSnapshot(key, false);
    writePanelSnapshot(storage, key, { tabs: [], activeIndex: null, visible: false, expanded: false });
    if (displayedContextKey === key) {
      panelTabs.value = [];
      activeTabId.value = null;
      panelVisible.value = false;
      panelExpanded.value = false;
      syncAgentConversation();
      resetDiffState();
    }
  }
  const stopContextListener = onPanelContextDestroyed(destroyContext);
  const stopBtwListener = onPanelBtwDestroyed((sessionId, agentId) => {
    let removed = removeStoredBtwTab(storage, sessionId, agentId);
    const snapshot = snapshotBySession[sessionId];
    if (snapshot !== undefined) {
      const selected = snapshot.activeIndex === null ? undefined : snapshot.tabs[snapshot.activeIndex];
      const removedTabs = snapshot.tabs.filter(
        tab => tab.type === 'btw' && (tab.payload as BtwTabPayload).agentId === agentId,
      );
      if (removedTabs.length > 0) {
        removed = true;
        for (const tab of removedTabs) onTabRemoved?.(tab);
        const tabs = snapshot.tabs.filter(tab => !removedTabs.includes(tab));
        const activeIndex =
          selected === undefined
            ? null
            : removedTabs.includes(selected)
              ? tabs.length > 0
                ? Math.min(snapshot.activeIndex ?? 0, tabs.length - 1)
                : null
              : tabs.findIndex(tab => tab.id === selected.id);
        const visible = tabs.length > 0 && snapshot.visible;
        snapshotBySession[sessionId] = {
          ...snapshot,
          tabs,
          activeIndex: activeIndex !== null && activeIndex >= 0 ? activeIndex : null,
          visible,
          expanded: visible && snapshot.expanded,
        };
      }
    }
    if (displayedContextKey === sessionId) {
      const targetTabs = panelTabs.value.filter(
        tab => tab.type === 'btw' && (tab.payload as BtwTabPayload).agentId === agentId,
      );
      if (targetTabs.length > 0) removed = true;
      for (const tab of targetTabs) closeTab(tab.id, { skipSideChatClose: true });
    }
    return removed;
  });
  const stopWorkspaceListener = onPanelWorkspaceDestroyed(workspaceId => {
    const keys = new Set(panelContextsOfWorkspace(storage, workspaceId));
    for (const [key, snapshot] of Object.entries(snapshotBySession)) if (snapshot.workspaceId === workspaceId) keys.add(key);
    if (displayedWorkspaceId === workspaceId) keys.add(displayedContextKey);
    for (const key of keys) destroyContext(key);
  });
  restoreSnapshot(displayedContextKey);
  const saveCurrent = (): void => captureSnapshot(displayedContextKey);
  watch([panelTabs, activeTabId, panelVisible, panelExpanded], saveCurrent, { flush: 'post' });
  if (typeof window !== 'undefined') window.addEventListener('pagehide', saveCurrent);
  if (getCurrentScope() !== undefined) onScopeDispose(() => {
    saveCurrent();
    stopContextListener();
    stopBtwListener();
    stopWorkspaceListener();
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', saveCurrent);
  });

  function updateTabPresentation(id: string, presentation: PanelTabPresentation | undefined): void {
    panelTabs.value = panelTabs.value.map(tab => tab.id === id ? { ...tab, presentation } : tab);
  }

  function updateTabPayload(id: string, payload: unknown): void {
    panelTabs.value = panelTabs.value.map(tab => tab.id === id ? { ...tab, payload, title: tabTitle(tab.type, payload) } : tab);
  }

  return {
    browserPersistenceReady,
    PREVIEW_WIDTH_KEY,
    PREVIEW_MIN,
    previewDefaultWidth,
    previewMax,
    previewWidth,
    previewPanelWidth,
    panelDragging,
    panelTabs,
    activeTabId,
    activeTab,
    panelVisible,
    panelExpanded,
    panelCanExpand,
    panelInteractionVersion: readonly(panelInteractionVersion),
    revealedTabId: readonly(revealedTabId),
    openTab,
    closeTab,
    updateTabPayload,
    updateTabPresentation,
    closeOtherTabs,
    moveTab,
    cycleTab,
    closeTabsToRight,
    closeAllTabs,
    activateTab,
    updateBrowserTabTitle,
    renameBrowserTab,
    moveTabAfter,
    updateBrowserTabFavicon,
    updateBrowserTabLoading,
    sessionBrowserTabs,
    browserTabOwner,
    addSessionBrowserTab,
    isSessionDestroyed: (sessionId: string) => destroyedContexts.has(sessionId),
    closeSessionBrowserTab,
    syncBrowserControls,
    controlledBrowserSessions,
    isBrowserSessionControlled,
    controlBrowserTab,
    releaseBrowserTab,
    releaseBrowserRun,
    releaseBrowserMainControl,
    addTabInBackground,
    hidePanel,
    showPanel,
    toggleExpanded,
    compactionPanelTextOf,
    isCompactionPanelOpen,
    openCompactionPanel,
    toggleCompactionPanel,
    agentPanelMemberOf,
    agentPanelTurnsOf,
    agentPanelLoadingOf,
    agentPanelLoadErrorOf,
    agentPanelLoadingMoreOf,
    agentPanelLoadMoreErrorOf,
    agentPanelHasMoreOf,
    agentPanelRunningOf,
    loadOlderAgentMessages,
    openAgentPanel,
    detailDiffMode,
    detailDiffPath,
    openDiffDetail,
    closeDiffDetail,
    selectDiffFile,
    openTurnDiff,
    openFilePreview,
    openFilesPanel,
    openSideChatTab,
    leaveChatView,
    bumpInteractionVersion,
  };
}
