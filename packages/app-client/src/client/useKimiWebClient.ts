
import { computed, h, reactive, ref, watch, watchEffect, type Component } from 'vue';
import { formatDuration as formatTaskDuration } from '@moonshot-ai/app-core/lib';
import {
  getKimiWebApi,
  notifyPluginsShelfEvent,
  notifySessionDeleted,
  notifySessionDestroyed,
  notifyWorkspaceDestroyed,
  openArchivedSettings,
  openModelPicker,
  t,
  traceClientEvent,
  traceKeyEvent,
} from './deps';
import { dismissToastByKey, nextToastKey, onToast, toast, toastReplaceRevision } from './toast';
import { planAdminBatchToast, undoBatchDirectionOf, type AdminBatchToastPlan } from './adminBatchToast';
import type { ToastOptions } from '@moonshot-ai/app-ui';
import { consumeDraftPromotionOnSessionChange, getDraftPromotion } from './draftPromotion';
import {
  DaemonApiError,
  isDaemonApiError,
  MANAGED_KIMI_CODE_PROVIDER_ID,
  type AppSessionWorktree,
  type AppWorkspace,
  type SessionWorktreeRetryInput,
} from '@moonshot-ai/app-core/api';
import {
  type DropPosition,
  type PinnedInsertTarget,
  type WorkspaceSortMode,
} from '@moonshot-ai/app-core/lib';
import type { ConnectIssue } from '@moonshot-ai/app-core/lib';
import { track } from '../contracts';
import { basename, isDesktop, logWarn, workspaceRootKey } from '@moonshot-ai/app-core/lib';
import { insertSessionByRecency, sessionDisplayStatus } from '@moonshot-ai/app-core/lib';
import {
  classifySessionEnvironment,
  sessionEnvironmentTag,
  sessionWorktreeBlocksSend,
  sessionWorktreeHoldsPrompts,
  type SessionEnvironmentKind,
} from '@moonshot-ai/app-core/lib';
import { buildApprovalBlock } from '@moonshot-ai/app-core/client';
import { ackThinkingPending, foldDaemonThinkingLevel } from '@moonshot-ai/app-core/lib';
import { permissionModeFromConfig } from '@moonshot-ai/app-core/lib';
import { clearTurnFileHistorySession } from './turnFileHistory';
import { ackSwarmPending, foldDaemonSwarmMode } from '@moonshot-ai/app-core/lib';
import { ackTowerPending, foldDaemonTowerMode } from '@moonshot-ai/app-core/lib';
import {
  effectiveThinkingLevel,
  matchEffortSwitchRule,
  matchModelSwitchRule,
  resolveModelSwitchHint,
  resolveModelSwitchWarning,
  upstreamModelIdFromConfigModels,
  type ModelSwitchAction,
  type ModelSwitchRule,
} from '@moonshot-ai/app-core/lib';
import { detect as detectKimiLocale } from '@moonshot-ai/app-i18n';
import { modelSwitchConfirmStore } from '../stores/modelSwitchConfirm';
import { effortSwitchStore } from '../stores/effortSwitch';
import { ackPlanPending, foldDaemonPlanMode } from '@moonshot-ai/app-core/lib';
import {
  composerSessionScope,
  draftSnapshotStorageKey,
  draftStorageKey,
  safeGetJson,
  safeGetString,
  safeRemove,
  safeSetString,
  STORAGE_KEYS,
} from '@moonshot-ai/app-core/lib';
import { liveComposerEditorFor } from '@moonshot-ai/app-composer/runtime';
import { createPromptPrediction } from './promptPrediction';
import { sessionTasksToAppTasks, subagentDisplayName } from '@moonshot-ai/app-core/client';
import {
  conversationTurnError,
  conversationTurnRetry,
  createConversationProjector,
  pendingPromptTurn,
  sessionPlansOf,
} from '@moonshot-ai/app-core/client';
import {
  findPromptMessage,
  turnResult,
  undoableOpener,
  type CompactionItem,
  type ConversationContinuation,
  type ConversationLoadError,
  type ConversationNotice,
  type ConversationTurn,
  type ConversationTurnHeader,
} from '@moonshot-ai/app-core/conversation';
import { useAppearance, useSessionMentions, useSidebarTabs } from '@moonshot-ai/app-core/composables';
import type { AppNoticeDetail } from '@moonshot-ai/app-core/contracts';
import { shouldNotifyCompletion } from '../composables/useNotification';
import { notificationsStore } from '../stores/notifications';
import { promptAttachmentToTurnAttachment } from './attachmentsToContent';
import { useModelProviderState, type PersistSessionProfilePatch } from './useModelProviderState';
import { useSideChat } from './useSideChat';
import { useTaskClock } from './useTaskClock';
import { useTaskOutputStream } from './useTaskOutputStream';
import type { ExtendedState, ManagedMembership } from './types';
import { createConversationPool, type ConversationEntry } from '../composables/useConversations';
import { createWorkspaceBoot } from './boot';
import { createSessionRoute } from './sessionRoute';
import { createSessionSelection } from './sessionSelection';
import { sessionReadScope, workspaceReadScope } from './observationScope';
import { createSessionActions } from './sessionActions';
import { usePromptPipeline } from './usePromptPipeline';
import { createChatMcpAutoOpen } from '../composables/chatMcpAuthorization';
import { useConfirmDialog } from '../composables/useConfirmDialog';
import { toastWithManage, useWorktreeManageDialogs } from '../composables/useWorktreeManageDialogs';
import { persistComposerDraftSnapshot } from '../lib/composerDraftLifecycle';
import { configureWorkspaceHooks } from '../lib/workspaceHooks';
import { workspaceModeActions } from '../lib/workspaceModeActions';
import { closeSessionBusyWindow, openSessionBusyWindow } from '../lib/perfTracking';
import { waitForSessionExecution, type SessionExecutionState } from '../lib/sessionExecutionReadiness';
import { sessionMentionCandidates as buildSessionMentionCandidates, type SessionMentionCandidate } from '../lib/sessionReferences';
import { useSessionAdmin } from './useSessionAdmin';
import { useBrowserTabTitle } from '../composables/useBrowserTabTitle';
import { useDocumentTitle } from '../composables/useDocumentTitle';
import { sessionsStore } from '../stores/sessions';
import { sessionListStore, setSessionListHooks, FLAT_SESSIONS_PAGE_SIZE } from '../stores/sessionList';
import { workspacesStore, setWorkspacesHooks } from '../stores/workspaces';
import { approvalsStore, setApprovalsHooks } from '../stores/approvals';
import { filesStore } from '../stores/files';
import { modelsStore } from '../stores/models';
import { modeStore } from '../stores/mode';
import { warningsStore, warningDetail } from '../stores/warnings';
import { goalStore } from '../stores/goal';
import { configStore, setConfigHooks } from '../stores/config';
import { hostsStore, setHostsHooks } from '../stores/hosts';
import { tasksStore, setTasksHooks } from '../stores/tasks';
import { agentStatesStore } from '../stores/agentStates';
import { setFilesHooks } from '../stores/files';
import { authStore, setAuthHooks } from '../stores/auth';
import { computeGateVerdict, mapDaemonAuthError, AUTH_MODEL_NOT_RESOLVED_CODE, type ChatGateInput, type ChatGateVerdict } from '../lib/chatGate';
import { permissionsStore } from '../stores/permissions';
import { promptStore } from '../stores/prompt';
import {
  connectionStore,
  getEventConn,
  setEventConn,
  type SessionWorkBaselineRun,
} from '../stores/connection';
import { sessionRuntimeStore } from '../stores/sessionRuntime';
import { sessionRatingStore } from '../stores/sessionRating';
import { sessionInfoStore } from '../stores/sessionInfo';
import { pinnedOrderStore } from '../stores/pinnedOrder';
import { worktreesStore } from '../stores/worktrees';
import { composerAttachmentStore } from '../lib/composerAttachmentStore';
import { formatTime, sessionViewsStore } from '../stores/sessionViews';

const MAIN_AGENT_ID = 'main';
const SESSION_NOT_FOUND_CODE = 40401;

const appearance = useAppearance();
import type {
  AppAgentState,
  AppAgentUsage,
  AppEvent,
  AppApprovalRequest,
  AppCatalogProvider,
  AppConfig,
  AppGoal,
  AppMessage,
  AppModel,
  AppProvider,
  AppQuestionRequest,
  AppSession,
  SessionPlan,
  AppSkill,
  AppTask,
  AppTurnError,
  AppTurnRetry,
  AppWarning,
  ApprovalDecision,
  KimiEventHandlers,
  KimiEventMeta,
  ManagedUserInfo,
  ReadRequestOptions,
  ThinkingLevel,
} from '@moonshot-ai/app-core/api';
import {
  createInitialState,
  reduceAppEvent,
  buildAgentErrorNotice,
  isModelTurnErrorNotice,
  toAppEvent,
  shallowEqualArray,
  type CompactionStatus,
  type KimiClientState,
} from '@moonshot-ai/app-core/api';

import { buildSwarmGroups, countSwarmMembers, swarmMembersByToolCall } from '@moonshot-ai/app-core/client';
import type { SwarmGroup, SwarmMember } from '@moonshot-ai/app-core/client';
import type {
  ActivityState,
  ActivationBadges,
  ApprovalBlock,
  ChatTurn,
  ConnectionState,
  ConversationStatus,
  DiffViewLine,
  PermissionMode,
  QueuedPromptView,
  Session,
  TaskItem,
  TaskState,
  TodoView,
  UIQuestion,
  Workspace,
  WorkspaceGroup,
  WorkspaceView,
} from '@moonshot-ai/app-core/client/types';

const ONBOARDED_STORAGE_KEY = STORAGE_KEYS.onboarded;

export type { ColorScheme, FontScale } from '@moonshot-ai/app-core/composables';

safeRemove(STORAGE_KEYS.codeFont);
safeRemove(STORAGE_KEYS.accent);
safeRemove(STORAGE_KEYS.theme);
safeRemove(STORAGE_KEYS.notifyOnComplete);
safeRemove(STORAGE_KEYS.notifyOnQuestion);
safeRemove(STORAGE_KEYS.notifyOnApproval);
safeRemove(STORAGE_KEYS.soundOnComplete);

export type {
  ExtendedState,
  ManagedMembership,
  PromptAttachment,
} from './types';

const rawState: ExtendedState = reactive({
  ...createInitialState(),
  get sessions() {
    return sessionsStore().sessions;
  },
  set sessions(next: AppSession[]) {
    sessionsStore().setSessions(next);
  },
  get activeSessionId() {
    return sessionsStore().activeSessionId;
  },
  set activeSessionId(id: string | undefined) {
    sessionsStore().setActiveSessionId(id);
  },
  get approvalsBySession() {
    return approvalsStore().approvalsBySession;
  },
  get goalBySession() {
    return goalStore().goalBySession;
  },
  get goalVersionBySession() {
    return goalStore().goalVersionBySession;
  },
  get questionsBySession() {
    return approvalsStore().questionsBySession;
  },
  get gitStatusBySession() {
    return filesStore().gitStatusBySession;
  },
  get warnings() {
    return warningsStore().warnings;
  },
  set warnings(next: AppWarning[]) {
    warningsStore().setWarnings(next);
  },
  sessionStatusSettledBySession: {},
  unavailableModelBySession: {},
  get serverVersion() {
    return configStore().serverVersion;
  },
  get webTitle() {
    return configStore().webTitle;
  },
  get dangerousBypassAuth() {
    return configStore().dangerousBypassAuth;
  },
  set dangerousBypassAuth(next: boolean) {
    configStore().dangerousBypassAuth = next;
  },
  get backend() {
    return configStore().backend;
  },
  get experimentalFlags() {
    return configStore().experimentalFlags;
  },
  workspaceName: 'kimi-code',
  get thinking() {
    return modeStore().thinking;
  },
  set thinking(next: ThinkingLevel | undefined) {
    modeStore().thinking = next;
  },
  get draftThinkingExplicit() {
    return modeStore().draftThinkingExplicit;
  },
  set draftThinkingExplicit(next: boolean) {
    modeStore().draftThinkingExplicit = next;
  },
  get thinkingBySession() {
    return modeStore().thinkingBySession;
  },
  set thinkingBySession(next: Record<string, ThinkingLevel>) {
    modeStore().thinkingBySession = next;
  },
  get pendingThinkingBySession() {
    return modeStore().pendingThinkingBySession;
  },
  set pendingThinkingBySession(next: Record<string, number>) {
    modeStore().pendingThinkingBySession = next;
  },
  get planModeBySession() {
    return modeStore().planModeBySession;
  },
  set planModeBySession(next: Record<string, boolean>) {
    modeStore().planModeBySession = next;
  },
  get planArmedBySession() {
    return modeStore().planArmedBySession;
  },
  set planArmedBySession(next: Record<string, boolean>) {
    modeStore().planArmedBySession = next;
  },
  get pendingPlanBySession() {
    return modeStore().pendingPlanBySession;
  },
  set pendingPlanBySession(next: Record<string, number>) {
    modeStore().pendingPlanBySession = next;
  },
  get swarmModeBySession() {
    return modeStore().swarmModeBySession;
  },
  set swarmModeBySession(next: Record<string, boolean>) {
    modeStore().swarmModeBySession = next;
  },
  get pendingSwarmBySession() {
    return modeStore().pendingSwarmBySession;
  },
  set pendingSwarmBySession(next: Record<string, number>) {
    modeStore().pendingSwarmBySession = next;
  },
  get towerModeBySession() {
    return modeStore().towerModeBySession;
  },
  set towerModeBySession(next: Record<string, boolean>) {
    modeStore().towerModeBySession = next;
  },
  get pendingTowerBySession() {
    return modeStore().pendingTowerBySession;
  },
  set pendingTowerBySession(next: Record<string, number>) {
    modeStore().pendingTowerBySession = next;
  },
  get goalModeBySession() {
    return modeStore().goalModeBySession;
  },
  set goalModeBySession(next: Record<string, boolean>) {
    modeStore().goalModeBySession = next;
  },

  loading: false,
  sessionLoading: false,
  get availableOpenInApps() {
    return configStore().availableOpenInApps;
  },
  get config() {
    return configStore().config;
  },
  set config(next: AppConfig | null) {
    configStore().config = next;
  },
  get sessionsFullyLoaded() {
    return sessionListStore().sessionsFullyLoaded;
  },
  set sessionsFullyLoaded(next: boolean) {
    sessionListStore().sessionsFullyLoaded = next;
  },
  get flatSessionsNextPageToken() {
    return sessionListStore().flatSessionsNextPageToken;
  },
  set flatSessionsNextPageToken(next: string | null) {
    sessionListStore().flatSessionsNextPageToken = next;
  },
  get flatSessionsHasMore() {
    return sessionListStore().flatSessionsHasMore;
  },
  set flatSessionsHasMore(next: boolean) {
    sessionListStore().flatSessionsHasMore = next;
  },
  get flatSessionsLoading() {
    return sessionListStore().flatSessionsLoading;
  },
  set flatSessionsLoading(next: boolean) {
    sessionListStore().flatSessionsLoading = next;
  },
  get flatSessionsLoadingMore() {
    return sessionListStore().flatSessionsLoadingMore;
  },
  set flatSessionsLoadingMore(next: boolean) {
    sessionListStore().flatSessionsLoadingMore = next;
  },
  get flatSessionsSeeded() {
    return sessionListStore().flatSessionsSeeded;
  },
  set flatSessionsSeeded(next: boolean) {
    sessionListStore().flatSessionsSeeded = next;
  },
  get doneSessions() {
    return sessionListStore().doneSessions;
  },
  set doneSessions(next: AppSession[]) {
    sessionListStore().doneSessions = next;
  },
  get doneSessionsNextPageToken() {
    return sessionListStore().doneSessionsNextPageToken;
  },
  set doneSessionsNextPageToken(next: string | null) {
    sessionListStore().doneSessionsNextPageToken = next;
  },
  get doneSessionsHasMore() {
    return sessionListStore().doneSessionsHasMore;
  },
  set doneSessionsHasMore(next: boolean) {
    sessionListStore().doneSessionsHasMore = next;
  },
  get doneSessionsLoading() {
    return sessionListStore().doneSessionsLoading;
  },
  set doneSessionsLoading(next: boolean) {
    sessionListStore().doneSessionsLoading = next;
  },
  get doneSessionsLoadingMore() {
    return sessionListStore().doneSessionsLoadingMore;
  },
  set doneSessionsLoadingMore(next: boolean) {
    sessionListStore().doneSessionsLoadingMore = next;
  },
  get doneSessionsSeeded() {
    return sessionListStore().doneSessionsSeeded;
  },
  set doneSessionsSeeded(next: boolean) {
    sessionListStore().doneSessionsSeeded = next;
  },
  mainView: 'chat',
});

function setSessions(next: AppSession[]): void {
  rawState.sessions = next;
}
function updateSession(id: string, update: (session: AppSession) => AppSession): void {
  rawState.sessions = rawState.sessions.map((s) => (s.id === id ? update(s) : s));
}
function upsertSessionSorted(session: AppSession): void {
  rawState.sessions = insertSessionByRecency(rawState.sessions, session);
}
function appendSession(session: AppSession): void {
  rawState.sessions = [...rawState.sessions, session];
}
function removeSession(id: string): void {
  rawState.sessions = rawState.sessions.filter((s) => s.id !== id);
}

function clearActiveUnread(): void {
  const active = rawState.activeSessionId;
  if (
    active &&
    sessionViewsStore().unreadBySession[active] &&
    typeof document !== 'undefined' &&
    document.visibilityState === 'visible'
  ) {
    sessionViewsStore().clearAutomaticUnread(active);
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEYS.unread || event.key === STORAGE_KEYS.manualUnread) {
      sessionViewsStore().reloadUnread();
      clearActiveUnread();
    }
  });
}

function recoverStaleConnection(): void {
  const conn = getEventConn();
  if (conn !== null && conn.health().stale) {
    traceKeyEvent('ws:stale-reconnect', {
      sessionId: rawState.activeSessionId,
      status: 'stale',
    });
    traceClientEvent('ws: stale socket on focus, reconnecting', {
      activeSessionId: rawState.activeSessionId,
    });
    conn.reconnect();
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    clearActiveUnread();
    recoverStaleConnection();
  });
}
if (typeof window !== 'undefined') {
  window.addEventListener('focus', recoverStaleConnection);
  window.addEventListener('online', recoverStaleConnection);
}

function setActiveSessionId(id: string | undefined): void {
  sessionReadScope.activate(id);
  consumeDraftPromotionOnSessionChange(id);
  if (id === undefined) permissionsStore().enterDraft();
  rawState.activeSessionId = id;
}

function forgetSession(sessionId: string): void {
  sessionReadScope.forget(sessionId);
  composerAttachmentStore.clear(sessionId);
  connectionStore().forgetSession(sessionId);
  auxiliaryConversations.forget(sessionId);
  mainConversations.forget(sessionId);
  sideChat.clearSideChatForSession(sessionId);
  removeSession(sessionId);
  sessionRuntimeStore().dispose(sessionId);
  approvalsStore().clearSessionApprovals(sessionId);
  approvalsStore().clearSessionQuestions(sessionId);
  tasksStore().forgetSessionTasks(sessionId);
  agentStatesStore().forgetSession(sessionId);
  delete rawState.goalBySession[sessionId];
  delete rawState.goalVersionBySession[sessionId];
  filesStore().clearSessionGitStatus(sessionId);
  filesStore().clearSessionFileTree(sessionId);
  sessionInfoStore().discard(sessionId);
  promptStore().clearOptimisticMessages(sessionId);
  delete rawState.sessionStatusSettledBySession[sessionId];
  notifiedInteractionIdsBySession.delete(sessionId);
  failedCompactionSettled.delete(sessionId);
  failedCompactionErrorDue.delete(sessionId);
  promptStore().forgetLocalTurnState(sessionId);
  promptStore().clearQueued(sessionId);
  promptStore().clearInFlight(sessionId);
  delete rawState.planModeBySession[sessionId];
  delete rawState.planArmedBySession[sessionId];
  delete rawState.pendingPlanBySession[sessionId];
  delete rawState.swarmModeBySession[sessionId];
  delete rawState.pendingSwarmBySession[sessionId];
  delete rawState.towerModeBySession[sessionId];
  delete rawState.pendingTowerBySession[sessionId];
  delete rawState.goalModeBySession[sessionId];
  delete rawState.thinkingBySession[sessionId];
  delete rawState.pendingThinkingBySession[sessionId];
  permissionsStore().clearSession(sessionId);
  modeStore().savePlanModeToStorage();
  modeStore().saveSwarmModeToStorage();
  modeStore().saveTowerModeToStorage();
  modeStore().saveGoalModeToStorage();
  sessionsStore().unpinSession(sessionId);
  sessionViewsStore().clearUnread(sessionId);
}

const connectIssue = computed<ConnectIssue | null>(() => authStore().connectIssue);

const MAIN_AGENT_STATE_WAIT_MS = 3000;

function whenSessionStatusSettled(sessionId: string): Promise<void> {
  if (rawState.sessionStatusSettledBySession[sessionId] === true) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      stop();
      resolve();
    };
    const timer = setTimeout(finish, MAIN_AGENT_STATE_WAIT_MS);
    const stop = watch(
      () => rawState.sessionStatusSettledBySession[sessionId] === true,
      (settled) => {
        if (settled) finish();
      },
    );
  });
}

function applyMainAgentState(sessionId: string, state: AppAgentState): void {
  if (state.model !== undefined && state.model !== '' && rawState.unavailableModelBySession?.[sessionId] !== undefined) {
    const nextUnavailable = { ...rawState.unavailableModelBySession };
    delete nextUnavailable[sessionId];
    rawState.unavailableModelBySession = nextUnavailable;
  }
  foldDaemonPlanMode(rawState, sessionId, state.planMode);
  foldDaemonSwarmMode(rawState, sessionId, state.swarmMode);
  foldDaemonTowerMode(rawState, sessionId, state.towerMode);
  modeStore().saveTowerModeToStorage();
  if (sessionRuntimeStore().peekRuntime(sessionId)?.pendingModel === undefined) {
    const model = state.model ?? '';
    updateSession(sessionId, (s) => (s.model === model ? s : { ...s, model }));
  }
  if (state.thinking !== undefined) {
    foldDaemonThinkingLevel(rawState, sessionId, state.thinking as ThinkingLevel);
  } else if (rawState.pendingThinkingBySession[sessionId] === undefined) {
    delete rawState.thinkingBySession[sessionId];
  }
  if (state.permissionMode !== undefined) {
    permissionsStore().foldDaemonMode(sessionId, state.permissionMode);
  }
  markSessionStatusSettled(sessionId);
}

function resyncMainAgentState(sessionId: string): void {
  const state = agentStatesStore().stateOf(sessionId, MAIN_AGENT_ID);
  if (state !== undefined) applyMainAgentState(sessionId, state);
}

function applyMainAgentUsage(sessionId: string, usage: AppAgentUsage): void {
  const contextLimit = usage.contextLimit ?? 0;
  updateSession(sessionId, (s) =>
    s.usage.contextTokens === usage.contextTokens && s.usage.contextLimit === contextLimit
      ? s
      : { ...s, usage: { ...s.usage, contextTokens: usage.contextTokens, contextLimit } },
  );
}

interface ProfileWriteTokens {
  model: number | undefined;
  thinking: number | undefined;
  swarm: number | undefined;
  tower: number | undefined;
  plan: number | undefined;
  permission: number | undefined;
}

function persistSessionProfile(
  patch: PersistSessionProfilePatch,
  sessionId?: string,
  preserveDraftThinking = false,
): Promise<boolean> {
  const sid = sessionId ?? rawState.activeSessionId;
  if (!sid) return Promise.resolve(false);
  const tokens: ProfileWriteTokens = {
    model: patch.model !== undefined ? sessionRuntimeStore().peekRuntime(sid)?.pendingModel : undefined,
    thinking: patch.thinking !== undefined ? rawState.pendingThinkingBySession[sid] : undefined,
    swarm: patch.swarmMode !== undefined ? rawState.pendingSwarmBySession[sid] : undefined,
    tower: patch.towerMode !== undefined ? rawState.pendingTowerBySession[sid] : undefined,
    plan: patch.planMode !== undefined ? rawState.pendingPlanBySession[sid] : undefined,
    permission:
      patch.permissionMode !== undefined && permissionsStore().explicit[sid] === patch.permissionMode
        ? permissionsStore().explicitSeqFor(sid)
        : undefined,
  };
  const chainMap = sessionRuntimeStore().profileWriteChainBySid;
  const prev = chainMap.get(sid) ?? Promise.resolve(true);
  const teardownGen = permissionsStore().sessionTeardownGenFor(sid);
  permissionsStore().noteSubmitPrepStart(sid);
  const run = prev.then(async (prevOk) => {
    if (permissionsStore().sessionTeardownGenFor(sid) !== teardownGen) return false;
    return (await writeSessionProfile(sid, patch, tokens, preserveDraftThinking)) && prevOk;
  });
  chainMap.set(sid, run);
  return run.then((ok) => {
    if (chainMap.get(sid) === run) chainMap.delete(sid);
    permissionsStore().noteSubmitPrepEnd(sid);
    return ok;
  });
}

async function writeSessionProfile(
  sid: string,
  patch: PersistSessionProfilePatch,
  tokens: ProfileWriteTokens,
  preserveDraftThinking: boolean,
): Promise<boolean> {
  let ok = true;
  try {
    await getKimiWebApi().updateSession(sid, patch);
  } catch (err) {
    ok = false;
    warningsStore().pushOperationFailure('persistSessionProfile', err, { sessionId: sid });
  }
  sessionRuntimeStore().ackModelPending(sid, tokens.model);
  ackThinkingPending(rawState, sid, tokens.thinking);
  ackSwarmPending(rawState, sid, tokens.swarm);
  ackTowerPending(rawState, sid, tokens.tower);
  ackPlanPending(rawState, sid, tokens.plan);
  permissionsStore().settleExplicit(sid, tokens.permission, ok);
  if (!ok || !preserveDraftThinking) resyncMainAgentState(sid);
  return ok;
}

async function whenSessionProfileSettled(sid: string): Promise<boolean> {
  let ok = true;
  for (;;) {
    const tail = sessionRuntimeStore().profileWriteChainBySid.get(sid);
    if (tail === undefined) return ok;
    ok = (await tail) && ok;
    if (sessionRuntimeStore().profileWriteChainBySid.get(sid) === tail) return ok;
  }
}

function loadStringFromStorage(key: string): string {
  try {
    return safeGetString(key) ?? '';
  } catch {
    return '';
  }
}
function readInjectedOnboarded(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('kimi_onboarded') === '1';
}
const injectedOnboarded = readInjectedOnboarded();
if (injectedOnboarded && loadStringFromStorage(ONBOARDED_STORAGE_KEY) !== '1') {
  try {
    safeSetString(ONBOARDED_STORAGE_KEY, '1');
  } catch {}
}
const onboarded = ref<boolean>(
  injectedOnboarded || loadStringFromStorage(ONBOARDED_STORAGE_KEY) === '1',
);
function setOnboarded(done: boolean): void {
  onboarded.value = done;
  try {
    safeSetString(ONBOARDED_STORAGE_KEY, done ? '1' : '0');
  } catch {}
  if (done) {
    (window as { kimiDesktop?: { setOnboarded?: () => void } }).kimiDesktop?.setOnboarded?.();
  }
}

function hasPendingLocalWork(sessionId: string): boolean {
  return (
    promptStore().inFlightBySession[sessionId] === true ||
    (promptStore().queuedBySession[sessionId] ?? []).length > 0 ||
    (promptStore().optimisticMessagesBySession[sessionId] ?? []).length > 0 ||
    promptStore().hasHeldFirstPrompt(sessionId)
  );
}

function hasEmptyPromptPredictionInput(sessionId: string): boolean {
  const editor = liveComposerEditorFor(composerSessionScope(sessionId));
  if (editor !== undefined) {
    return editor.getText().trim().length === 0 && editor.getAttachmentInventory().activeIds.size === 0;
  }
  if ((safeGetString(draftStorageKey(sessionId)) ?? '').trim().length > 0) return false;
  const snapshot = safeGetJson<{ attachmentOrder?: unknown }>(draftSnapshotStorageKey(sessionId));
  return !Array.isArray(snapshot?.attachmentOrder) || snapshot.attachmentOrder.length === 0;
}

function canUsePromptPrediction(sessionId: string): boolean {
  return (
    rawState.experimentalFlags?.['prompt_prediction'] === true &&
    sessionId === rawState.activeSessionId &&
    rawState.mainView === 'chat' &&
    !rawState.sessionLoading &&
    typeof document !== 'undefined' &&
    document.visibilityState === 'visible' &&
    !modeStore().planMode &&
    !modeStore().planArmed &&
    !modeStore().goalMode &&
    !hasPendingLocalWork(sessionId) &&
    (rawState.approvalsBySession[sessionId] ?? []).length === 0 &&
    (rawState.questionsBySession[sessionId] ?? []).length === 0
  );
}

const promptPredictionController = createPromptPrediction({
  api: getKimiWebApi,
  isActiveSession: (sessionId) => sessionId === rawState.activeSessionId,
  canPredict: canUsePromptPrediction,
  hasEmptyInput: hasEmptyPromptPredictionInput,
});

watchEffect(() => {
  promptPredictionController.refresh();
});

function conversationConnection(): ReturnType<typeof getEventConn> {
  connectEventsIfNeeded();
  return getEventConn();
}

function reportConversationLoadFailure(entry: ConversationEntry, error: ConversationLoadError): void {
  warningsStore().pushOperationFailure(
    'loadConversation',
    new DaemonApiError({ code: error.code, msg: error.msg, requestId: '' }),
    { sessionId: entry.sessionId },
  );
}

function failConversations(sessionId: string, code: number, msg: string): void {
  if (code === SESSION_NOT_FOUND_CODE) {
    void sessionListStore().applySessionDeletedLocally(sessionId);
    return;
  }
  mainConversations.failSession(sessionId, { code, msg });
  auxiliaryConversations.failSession(sessionId, { code, msg });
}

const auxiliaryConversations = createConversationPool({
  api: getKimiWebApi,
  connection: conversationConnection,
  maxParked: 6,
  listener: {
    onChange: (entry) => sideChat.pruneEchoedMessages(entry.sessionId, entry.agentId),
  },
});

const mainConversations = createConversationPool({
  api: getKimiWebApi,
  connection: conversationConnection,
  maxParked: 3,
  retain: (entry) => hasPendingLocalWork(entry.sessionId),
  listener: {
    onPage: onMainPage,
    onTurnStarted: onMainTurnStarted,
    onTurnEnded: onMainTurnEnded,
    onTurnsRemoved: onMainTurnsRemoved,
    onItem: (entry, item) => {
      if (item.type === 'user_message') pruneEchoedPrompts(entry.sessionId);
      if (item.type === 'system' && item.kind === 'compaction') settleMainCompaction(entry, false);
    },
    onChange: (entry) => observeMainRating(entry.sessionId),
    onNotice: (entry, notice) => onMainNotice(entry.sessionId, notice),
    onLoadFailed: reportConversationLoadFailure,
  },
  onEvicted: (entry) => {
    agentStatesStore().forgetAgent(entry.sessionId, entry.agentId);
  },
});

function mainConversationOf(sessionId: string): ConversationEntry | undefined {
  return mainConversations.getEntry(sessionId, MAIN_AGENT_ID);
}

function mainTurnsOf(sessionId: string): readonly ConversationTurn[] {
  return mainConversationOf(sessionId)?.view.turns ?? [];
}

function mainTurnRunning(sessionId: string): boolean {
  const state = agentStatesStore().stateOf(sessionId, MAIN_AGENT_ID);
  if (state === undefined) return rawState.sessions.find((session) => session.id === sessionId)?.mainTurnActive === true;
  return state.status === 'running';
}

function mainCompacting(sessionId: string): boolean {
  return agentStatesStore().stateOf(sessionId, MAIN_AGENT_ID)?.compacting === true;
}

function observeMainCompaction(sessionId: string): void {
  if (!mainCompacting(sessionId)) return;
  failedCompactionSettled.delete(sessionId);
  failedCompactionErrorDue.delete(sessionId);
  promptStore().noteCompactionStarted(sessionId);
}

const failedCompactionSettled = new Set<string>();
const failedCompactionErrorDue = new Set<string>();

const latestCompactionKeyByEntry = new WeakMap<ConversationEntry, string | undefined>();

function settleMainCompaction(entry: ConversationEntry, initial: boolean): void {
  const latest = latestCompactionOf(entry.view.turns);
  const seen = latestCompactionKeyByEntry.get(entry);
  latestCompactionKeyByEntry.set(entry, latest?.key);
  if (initial || latest === undefined || latest.key === seen) return;
  if (latest.item.error === undefined) {
    settleCompaction(entry.sessionId, 'completed', latest.item.trigger);
    return;
  }
  failedCompactionSettled.add(entry.sessionId);
  settleCompaction(entry.sessionId, 'cancelled', latest.item.trigger);
}

function settleCompaction(
  sessionId: string,
  outcome: 'completed' | 'cancelled',
  trigger: 'manual' | 'auto' | undefined,
): void {
  promptStore().noteCompactionSettled(sessionId);
  const gateOwnsResume = modelSwitchConfirmStore().hasCompactionWait(sessionId);
  if (gateOwnsResume) modelSwitchConfirmStore().noteCompactionSettled(sessionId, outcome);
  if (outcome === 'completed' && trigger !== 'manual') promptStore().noteAutoCompacted(sessionId);
  if (!gateOwnsResume) promptPipeline.resumeAfterCompaction(sessionId);
}

function latestCompactionOf(turns: readonly ConversationTurn[]): { key: string; item: CompactionItem } | undefined {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    const item = turn.items.findLast(
      (candidate): candidate is CompactionItem => candidate.type === 'system' && candidate.kind === 'compaction',
    );
    if (item !== undefined) return { key: `${turn.turn_id}\u0000${item.item_id}`, item };
  }
  return undefined;
}

function activeMainConversation(): ConversationEntry | null {
  const sid = rawState.activeSessionId;
  if (!sid) return null;
  const entry = mainConversationOf(sid);
  void entry?.version.value;
  return entry !== undefined && entry.loaded ? entry : null;
}

function awaitedInteractionIds(turn: ConversationTurn | undefined): string[] {
  return (turn?.items ?? []).flatMap((item) =>
    item.type === 'tool_call' && item.stage === 'awaiting_approval' && item.interaction_id !== undefined
      ? [item.interaction_id]
      : [],
  );
}

function sessionExecutionState(sessionId: string): SessionExecutionState {
  const entry = mainConversationOf(sessionId);
  void entry?.version.value;
  if (connection.value !== 'connected' || entry?.loaded !== true) {
    return { turnId: null, status: 'unknown' };
  }
  const turn = entry.view.turns.at(-1);
  const turnId = turn?.turn_id ?? null;
  if (!mainTurnRunning(sessionId)) return { turnId, status: 'idle' };
  const awaited = awaitedInteractionIds(turn);
  if (awaited.length > 0) {
    const resolving = awaited.every((interactionId) => approvalsStore().isApprovalAnswered(sessionId, interactionId));
    return resolving ? { turnId, status: 'paused', resolving } : { turnId, status: 'paused' };
  }
  return { turnId, status: 'running' };
}

function mainWaitForCallId(sessionId: string): string | undefined {
  const tail = mainTurnsOf(sessionId).at(-1);
  if (tail?.status !== 'running') return undefined;
  const wait = tail.items.findLast(
    (item) => item.type === 'tool_call' && item.name === 'WaitFor' && item.status === 'running' && item.input !== undefined,
  );
  return wait?.item_id;
}

function mainWaitForWaiting(sessionId: string): boolean {
  return mainWaitForCallId(sessionId) !== undefined;
}

function openerPromptId(turn: ConversationTurn | undefined): string | undefined {
  const opener = turn?.items[0];
  return opener?.type === 'user_message' && opener.placement === 'opener' ? opener.prompt_ids[0] : undefined;
}

function mainPromptIdToAbort(sessionId: string): string | undefined {
  const tail = mainTurnsOf(sessionId).at(-1);
  if (tail?.status === 'running') return openerPromptId(tail);
  const pending = unechoedOptimisticMessages(sessionId).at(-1);
  return pending === undefined ? undefined : promptIdOf(pending);
}

let optimisticMsgSeq = 0;
function nextOptimisticMsgId(): string {
  optimisticMsgSeq += 1;
  return `msg_opt_${Date.now().toString(36)}_${optimisticMsgSeq}`;
}

function applyEvent(event: ReturnType<typeof toAppEvent>, sessionId: string): void {
  if (event.type === 'sessionDeleted') {
    void sessionListStore().applySessionDeletedLocally(event.sessionId);
    return;
  }
  const snapshot: KimiClientState = {
    sessions: rawState.sessions,
    activeSessionId: rawState.activeSessionId,
    approvalsBySession: rawState.approvalsBySession,
    questionsBySession: rawState.questionsBySession,
    goalBySession: rawState.goalBySession,
    goalVersionBySession: rawState.goalVersionBySession,
    config: rawState.config,
    warnings: rawState.warnings,
  };
  const next = reduceAppEvent(snapshot, event, { sessionId }, {
    t: (k, p) => (p === undefined ? t(k) : t(k, p)),
  });
  if (next.sessions !== snapshot.sessions) setSessions(next.sessions);
  if (next.activeSessionId !== snapshot.activeSessionId) {
    setActiveSessionId(next.activeSessionId);
  }
  approvalsStore().applyApprovalsDiff(next.approvalsBySession);
  approvalsStore().applyQuestionsDiff(next.questionsBySession);
  goalStore().applyGoalDiff(next.goalBySession, next.goalVersionBySession);
  if (next.config !== snapshot.config) rawState.config = next.config ?? null;
  if (!shallowEqualArray(next.warnings, snapshot.warnings)) {
    warningsStore().setWarnings(next.warnings);
  }

  if (event.type === 'configChanged') {
    configStore().noteConfigWrite();
    modelsStore().setDefaultModel(event.config.defaultModel ?? null);
    for (const warning of event.warnings ?? []) {
      warningsStore().pushWarning({
        severity: 'warning',
        title: warning.domain ?? 'config',
        message: warning.message,
      });
    }
    void authStore().checkAuth();
  }

  if (event.type === 'modelCatalogChanged') {
    void modelProvider.loadModels();
    void modelProvider.loadProviders();
    void authStore().checkAuth();
  }

  if (event.type === 'sessionWorkChanged') {
    sessionRuntimeStore().noteLastTurnReasonChange(event.sessionId);
  }
  if (event.type === 'sessionCreated') {
    sessionListStore().notePoolInsert(event.session.id);
  }
}

const notifiedInteractionIdsBySession = new Map<string, Set<string>>();

function markInteractionNotified(sessionId: string, interactionId: string): boolean {
  let notified = notifiedInteractionIdsBySession.get(sessionId);
  if (notified === undefined) {
    notified = new Set();
    notifiedInteractionIdsBySession.set(sessionId, notified);
  }
  if (notified.has(interactionId)) return false;
  notified.add(interactionId);
  return true;
}

function processEvent(appEvent: AppEvent, meta: KimiEventMeta): void {
  connectionStore().noteSessionEvent(meta.sessionId);
  const requestedAgentId =
    appEvent.type === 'approvalRequested'
      ? appEvent.approval.agentId
      : appEvent.type === 'questionRequested'
        ? appEvent.question.agentId
        : undefined;
  if (
    requestedAgentId !== undefined &&
    sideChat.isClosedSideChatAgent(meta.sessionId, requestedAgentId)
  ) {
    return;
  }
  const wasMainTurnActive = rawState.sessions.find((s) => s.id === meta.sessionId)?.mainTurnActive === true;
  applyEvent(appEvent, meta.sessionId);

  if (
    appEvent.type === 'approvalRequested' &&
    markInteractionNotified(meta.sessionId, appEvent.approval.approvalId)
  ) {
    scheduleSessionRowRefresh(meta.sessionId);
    onApprovalRequested(meta.sessionId, appEvent.approval);
  } else if (
    appEvent.type === 'questionRequested' &&
    markInteractionNotified(meta.sessionId, appEvent.question.questionId)
  ) {
    scheduleSessionRowRefresh(meta.sessionId);
    onQuestionRequested(meta.sessionId, appEvent.question);
  } else if (appEvent.type === 'interactionEnded') {
    notifiedInteractionIdsBySession.get(meta.sessionId)?.delete(appEvent.interactionId);
  }

  if (
    appEvent.type === 'sessionWorkChanged' &&
    (appEvent.mainTurnActive === false || !appEvent.busy) &&
    wasMainTurnActive
  ) {
    scheduleSessionRowRefresh(meta.sessionId);
  }
}

function markSessionStatusSettled(sid: string): void {
  if (rawState.sessionStatusSettledBySession[sid] === true) return;
  rawState.sessionStatusSettledBySession = { ...rawState.sessionStatusSettledBySession, [sid]: true };
}

function applySessionWorkBaseline(
  sessions: AppSession[],
  run: SessionWorkBaselineRun,
): void {
  const baselineById = new Map(sessions.map((session) => [session.id, session] as const));
  let sessionsChanged = false;
  const authoritativePendingBySession = new Map<
    string,
    'none' | 'approval' | 'question'
  >();
  const nextSessions = rawState.sessions.map((session) => {
    const baseline = baselineById.get(session.id);
    if (baseline === undefined) return session;
    const workChanged = run.workEventSessions.has(session.id);
    const pendingSource = run.pendingEventSourceBySession.get(session.id);
    const busy = workChanged ? session.busy || session.mainTurnActive === true : baseline.busy;
    const mainTurnActive =
      workChanged
        ? session.mainTurnActive
        : baseline.mainTurnActive ?? (busy ? session.mainTurnActive : false);
    const pendingInteraction =
      pendingSource === 'work'
        ? session.pendingInteraction
        : pendingSource === 'interaction'
          ? (rawState.approvalsBySession[session.id]?.length ?? 0) > 0
            ? 'approval'
            : (rawState.questionsBySession[session.id]?.length ?? 0) > 0
              ? 'question'
              : 'none'
          : baseline.pendingInteraction ?? (busy ? session.pendingInteraction : 'none');
    if (
      (pendingSource === 'work' ||
        (pendingSource === undefined &&
          (baseline.pendingInteraction !== undefined || baseline.busy === false))) &&
      pendingInteraction !== undefined
    ) {
      authoritativePendingBySession.set(session.id, pendingInteraction);
    }
    const lastTurnReason = workChanged ? session.lastTurnReason : baseline.lastTurnReason;
    const title = run.titleEventSessions.has(session.id) ? session.title : baseline.title;
    const cwd = workChanged ? session.cwd : baseline.cwd;
    const worktree =
      workChanged || JSON.stringify(session.worktree) === JSON.stringify(baseline.worktree)
        ? session.worktree
        : baseline.worktree;
    if (
      session.busy === busy &&
      session.mainTurnActive === mainTurnActive &&
      session.pendingInteraction === pendingInteraction &&
      session.lastTurnReason === lastTurnReason &&
      session.title === title &&
      session.cwd === cwd &&
      session.worktree === worktree
    ) {
      return session;
    }
    sessionsChanged = true;
    return {
      ...session,
      busy,
      mainTurnActive,
      pendingInteraction,
      lastTurnReason,
      title,
      cwd,
      worktree,
    };
  });
  if (sessionsChanged) setSessions(nextSessions);
  for (const [sessionId, pendingInteraction] of authoritativePendingBySession) {
    if (pendingInteraction === 'none') {
      approvalsStore().clearSessionApprovals(sessionId);
      approvalsStore().clearSessionQuestions(sessionId);
    } else if (pendingInteraction === 'question') {
      approvalsStore().clearSessionApprovals(sessionId);
    }
  }
}

async function reconcileSessionWorkAfterReconnect(): Promise<void> {
  const run: SessionWorkBaselineRun = {
    workEventSessions: new Set(),
    titleEventSessions: new Set(),
    pendingEventSourceBySession: new Map(),
  };
  connectionStore().beginSessionWorkBaseline(run);

  try {
    const result = await sessionListStore().listAllSessionsGlobal();
    if (!connectionStore().isSessionWorkBaselineCurrent(run) || !connectionStore().connected)
      return;
    applySessionWorkBaseline(result.sessions, run);
    connectionStore().clearSessionWorkBaseline();
    connectionStore().resetSessionWorkBaselineBackoff();
  } catch (error) {
    if (!connectionStore().isSessionWorkBaselineCurrent(run) || !connectionStore().connected)
      return;
    connectionStore().clearSessionWorkBaseline();
    connectionStore().scheduleSessionWorkBaselineRetry(error, retrySessionWorkBaseline);
  }
}

function retrySessionWorkBaseline(): void {
  void reconcileSessionWorkAfterReconnect();
}

interface SkillRootsRefreshState {
  readonly rootsKey: string;
  readonly failed: boolean;
}

const refreshedSkillRootsByWorkspace = new Map<string, SkillRootsRefreshState>();

function skillRootsKey(workspace: AppWorkspace): string {
  return JSON.stringify([workspace.hostId ?? null, workspace.root, ...(workspace.additionalDirs ?? [])]);
}

function hasFailedSkillsRefresh(workspace: AppWorkspace): boolean {
  const state = refreshedSkillRootsByWorkspace.get(workspace.id);
  return state?.failed === true && state.rootsKey === skillRootsKey(workspace);
}

function sessionBelongsToRoots(session: AppSession, workspace: AppWorkspace): boolean {
  if (session.workspaceId !== undefined) return session.workspaceId === workspace.id;
  const sessionRoot = workspaceRootKey(session.cwd);
  return [workspace.root, ...(workspace.additionalDirs ?? [])].some(
    (dir) => workspaceRootKey(dir) === sessionRoot,
  );
}

function refreshSkillsForRoots(workspace: AppWorkspace, previousWorkspace?: AppWorkspace): void {
  const rootsKey = skillRootsKey(workspace);
  const previousState = refreshedSkillRootsByWorkspace.get(workspace.id);
  if (previousState?.rootsKey === rootsKey && !previousState.failed) return;
  const sessionIds = new Set<string>();
  for (const roots of [previousWorkspace, workspace]) {
    if (roots === undefined) continue;
    for (const session of rawState.sessions) {
      if (sessionBelongsToRoots(session, roots)) sessionIds.add(session.id);
    }
  }
  modelProvider.invalidateSkillsForWorkspace(workspace.id);
  for (const sessionId of sessionIds) modelProvider.invalidateSkillsForSession(sessionId);
  const state: SkillRootsRefreshState = { rootsKey, failed: false };
  refreshedSkillRootsByWorkspace.set(workspace.id, state);
  if (activeWorkspaceId.value !== workspace.id || activeWorkspaceTrust.value !== true) return;
  const requests: Promise<boolean>[] = [
    modelProvider.loadSkillsForWorkspace(
      workspace.id,
      workspaceReadScope.options(workspace.id),
    ),
  ];
  const sid = rawState.activeSessionId;
  const session = rawState.sessions.find((candidate) => candidate.id === sid);
  if (
    sid !== undefined &&
    session !== undefined &&
    workspacesStore().sessionBelongsToWorkspace(session, workspace.id)
  ) {
    requests.push(modelProvider.loadSkillsForSession(sid, sessionReadScope.options(sid)));
  }
  void Promise.all(requests).then((results) => {
    if (results.every(Boolean)) return;
    if (refreshedSkillRootsByWorkspace.get(workspace.id) === state) {
      refreshedSkillRootsByWorkspace.set(workspace.id, { ...state, failed: true });
    }
  });
}

function loadHostSessions(hostId: string): void {
  for (const workspace of workspacesStore().workspaces) {
    if (workspace.hostId === hostId) void sessionListStore().loadFirstWorkspacePage(workspace.id);
  }
}

function loadActiveHostModels(hostId: string): void {
  if (hostId !== workspacesStore().visibleWorkspace?.hostId) return;
  void modelsStore().loadHostCatalog(hostId).catch((err: unknown) => {
    logWarn('[kimi-code] loading models from SSH host failed', hostId, err);
  });
}

watch(
  () => workspacesStore().visibleWorkspace?.hostId,
  (hostId) => {
    modelsStore().setActiveHost(hostId);
    if (hostId !== undefined && hostsStore().hostFor(hostId)?.status === 'ready') loadActiveHostModels(hostId);
  },
  { immediate: true },
);

function refreshActiveHostWorkspace(hostId: string): void {
  const workspace = workspacesStore().workspaces.find(
    (candidate) => candidate.id === activeWorkspaceId.value && candidate.hostId === hostId,
  );
  if (workspace === undefined) return;
  if (activeWorkspaceTrust.value === undefined) observeWorkspace(workspace.id);
  if (hasFailedSkillsRefresh(workspace)) refreshSkillsForRoots(workspace);
  const sid = rawState.activeSessionId;
  if (sid !== undefined) {
    void filesStore().loadGitStatus(sid, sessionReadScope.options(sid));
    if (filesStore().fileTreeBySession[sid] !== undefined) void filesStore().refreshFileTree(sid);
    return;
  }
  const treeKey = `workspace:${workspace.root}`;
  if (filesStore().fileTreeBySession[treeKey] !== undefined) {
    void filesStore().refreshFileTree(treeKey, { workspaceId: workspace.id, root: workspace.root });
  }
}

function applyHostAccountEvent(hostId: string, event: AppEvent): boolean {
  switch (event.type) {
    case 'modelCatalogChanged':
      loadActiveHostModels(hostId);
      void hostsStore().loadAccount(hostId);
      return true;
    case 'configChanged':
      modelsStore().setHostDefaultModel(hostId, event.config.defaultModel ?? null);
      void hostsStore().loadAccount(hostId);
      return true;
    case 'pluginsChanged':
    case 'capabilityChanged':
      return true;
    default:
      return false;
  }
}

function createOnEventHandler(): KimiEventHandlers['onEvent'] {
  return (appEvent, meta) => {
    if (meta.hostId !== undefined && applyHostAccountEvent(meta.hostId, appEvent)) return;
    if (appEvent.type === 'hostsChanged') {
      const { becameReady: ready } = hostsStore().applySnapshot(appEvent.hosts);
      if (ready.length > 0) {
        void workspacesStore().loadWorkspaces().then(() => {
          for (const hostId of ready) loadHostSessions(hostId);
        });
      }
      for (const hostId of ready) {
        refreshActiveHostWorkspace(hostId);
        loadActiveHostModels(hostId);
      }
      return;
    }
    if (appEvent.type === 'sessionArchived') {
      void sessionListStore()
        .applyRemoteSessionArchived(appEvent.sessionId, appEvent.workspaceId)
        .then((genuine) => {
          if (!genuine) return;
          notifySessionDestroyed(appEvent.sessionId);
        });
      return;
    }
    if (appEvent.type === 'sessionRestored') {
      void sessionListStore().applyRemoteSessionRestored(appEvent.sessionId);
      return;
    }
    if (
      appEvent.type === 'workspaceCreated' ||
      appEvent.type === 'workspaceUpdated' ||
      appEvent.type === 'workspaceDeleted'
    ) {
      if (appEvent.type === 'workspaceDeleted') {
        refreshedSkillRootsByWorkspace.delete(appEvent.workspaceId);
        const sessionIds = rawState.sessions
          .filter((session) => workspacesStore().sessionBelongsToWorkspace(session, appEvent.workspaceId))
          .map((session) => session.id);
        notifyWorkspaceDestroyed(appEvent.workspaceId, appEvent.root, sessionIds);
      }
      const previous = appEvent.type === 'workspaceUpdated'
        ? workspacesStore().workspaces.find((workspace) => workspace.id === appEvent.workspace.id)
        : undefined;
      const previousDirs = previous?.additionalDirs ?? [];
      const nextDirs = appEvent.type === 'workspaceUpdated' ? (appEvent.workspace.additionalDirs ?? []) : [];
      const rootsChanged = appEvent.type === 'workspaceUpdated' && (
        previous === undefined ||
        previous.root !== appEvent.workspace.root ||
        previousDirs.length !== nextDirs.length ||
        previousDirs.some((dir, index) => dir !== nextDirs[index])
      );
      workspacesStore().applyWorkspaceEvent(appEvent);
      if (
        appEvent.type === 'workspaceUpdated' &&
        (rootsChanged || hasFailedSkillsRefresh(appEvent.workspace))
      ) {
        refreshSkillsForRoots(appEvent.workspace, previous);
      }
      return;
    }
    if (
      (appEvent.type === 'pluginsChanged' || appEvent.type === 'capabilityChanged') &&
      notifyPluginsShelfEvent(appEvent)
    ) {
      return;
    }
    const isWorkEvent = appEvent.type === 'sessionWorkChanged';
    const isInteractionEvent =
      appEvent.type === 'approvalRequested' ||
      appEvent.type === 'questionRequested' ||
      appEvent.type === 'interactionEnded' ||
      appEvent.type === 'interactionsReset';
    const baselineRun = connectionStore().sessionWorkBaseline.run;
    if (baselineRun !== null) {
      if (isWorkEvent) {
        baselineRun.workEventSessions.add(meta.sessionId);
        if (appEvent.session?.title !== undefined) baselineRun.titleEventSessions.add(meta.sessionId);
        if (appEvent.pendingInteraction !== undefined || !appEvent.busy) {
          baselineRun.pendingEventSourceBySession.set(meta.sessionId, 'work');
        }
      } else if (isInteractionEvent) {
        baselineRun.pendingEventSourceBySession.set(meta.sessionId, 'interaction');
      } else if (appEvent.type === 'sessionMetaUpdated' && appEvent.title !== undefined) {
        baselineRun.titleEventSessions.add(meta.sessionId);
      }
    }

    processEvent(appEvent, meta);
  };
}

function createOnErrorHandler(): KimiEventHandlers['onError'] {
  return (code, msg, fatal) => {
    traceKeyEvent('ws:error', {
      status: 'failed',
      errorCode: code,
      fatal,
    });
    warningsStore().pushWarning({
      severity: 'error',
      title: t('warnings.wsTitle'),
      message: msg,
      details: [warningDetail('message', msg)].filter(
        (detail): detail is AppNoticeDetail => detail !== undefined,
      ),
    });
  };
}

function createOnConnectionChangeHandler(): KimiEventHandlers['onConnectionChange'] {
  return (connected) => {
    traceKeyEvent('ws:connection', {
      status: connected ? 'connected' : 'disconnected',
    });
    if (connected) {
      const disconnectedAt = connectionStore().markConnected();
      if (disconnectedAt !== null) {
        track('connection_restored', {
          duration_ms: Math.min(Date.now() - disconnectedAt, 86_400_000),
        });
      }
      warningsStore().dismissWsError();
      void configStore().refreshServerMeta();
      sideChat.flushPendingCloses();
      if (connectionStore().connectionGeneration > 1) {
        void workspacesStore().loadWorkspaces();
        void reconcileSessionWorkAfterReconnect();
      }
    } else {
      if (connectionStore().markDisconnected()) {
        track('connection_lost', {});
      }
    }
  };
}

function createOnConversationHandler(): NonNullable<KimiEventHandlers['onConversation']> {
  const autoOpen = createChatMcpAutoOpen();
  return (sessionId, agentId, frame) => {
    if (agentId !== MAIN_AGENT_ID) {
      auxiliaryConversations.handleFrame(sessionId, agentId, frame);
      return;
    }
    mainConversations.handleFrame(sessionId, agentId, frame);
    if (frame.type === 'turns') {
      autoOpen(frame, undefined, false);
      return;
    }
    if (frame.type !== 'item.updated' || frame.set.fields === undefined) return;
    const entry = mainConversationOf(sessionId);
    if (!entry?.loaded) return;
    const turn = entry.view.turns.findLast(candidate => candidate.turn_id === frame.turn_id);
    autoOpen(frame, turn, isUserWatching(sessionId) && rawState.sessions.some(row => row.id === sessionId) && chatHostId(sessionId) === undefined);
  };
}

export function connectEventsIfNeeded(): void {
  if (getEventConn() !== null) return;
  if (typeof WebSocket === 'undefined') return;

  traceKeyEvent('ws:connection', { status: 'connecting' });
  connectionStore().markConnecting();

  const api = getKimiWebApi();

  setEventConn(
    api.connectEvents({
      onEvent: createOnEventHandler(),
      onError: createOnErrorHandler(),
      onConnectionChange: createOnConnectionChangeHandler(),
      onConversation: createOnConversationHandler(),
      onConversationFailed: failConversations,
      onTaskList: (sessionId, agentId, tasks) => {
        tasksStore().replaceRunningTasks(sessionId, agentId, tasks);
      },
      onTask: (sessionId, agentId, task) => {
        tasksStore().upsertTask(sessionId, agentId, task);
      },
      onAgentState: (sessionId, agentId, state) => {
        if (state.status === 'ended') {
          agentStatesStore().forgetAgent(sessionId, agentId);
          sideChat.handleAgentEnded(sessionId, agentId);
          return;
        }
        agentStatesStore().setState(sessionId, agentId, state);
        if (agentId !== MAIN_AGENT_ID) return;
        promptStore().settleContinueTurnStart(sessionId);
        applyMainAgentState(sessionId, state);
        observeMainCompaction(sessionId);
        if (state.status === 'idle') promptPipeline.resumeQueueIfIdle(sessionId);
      },
      onAgentUsage: (sessionId, agentId, usage) => {
        agentStatesStore().setUsage(sessionId, agentId, usage);
        if (agentId === MAIN_AGENT_ID) applyMainAgentUsage(sessionId, usage);
      },
      onAgentGoal: (sessionId, agentId, goal) => {
        if (agentId === MAIN_AGENT_ID) goalStore().applyGoalFrame(sessionId, goal);
      },
      onAgentTodos: (sessionId, agentId, todos) => {
        agentStatesStore().setTodos(sessionId, agentId, todos);
      },
      onTaskOutput: taskOutputStream.receive,
      onTaskOutputFailed: taskOutputStream.fail,
    }),
  );
}

function hasLoadedMessages(sessionId: string): boolean {
  return mainConversationOf(sessionId)?.loaded === true;
}

function whenMainConversationLoaded(sessionId: string): Promise<void> {
  const entry = mainConversationOf(sessionId);
  return entry === undefined ? Promise.resolve() : mainConversations.whenLoaded(entry);
}

function mergeSessionRowDurable(sessionId: string, row: Partial<AppSession>): void {
  updateSession(sessionId, (s) => ({
    ...s,
    title: row.title ?? s.title,
    archived: row.archived ?? s.archived,
    archivedAt: row.archivedAt ?? s.archivedAt,
    updatedAt:
      row.updatedAt !== undefined && row.updatedAt > s.updatedAt ? row.updatedAt : s.updatedAt,
    lastPrompt: row.lastPrompt ?? s.lastPrompt,
    messageCount: row.messageCount ?? s.messageCount,
  }));
}

const sessionRowRefreshBySession = new Map<string, Promise<void>>();

function scheduleSessionRowRefresh(sessionId: string): void {
  if (sessionRowRefreshBySession.has(sessionId)) return;
  const task = (async () => {
    try {
      const row: Partial<AppSession> | undefined = await getKimiWebApi().getSession(sessionId);
      if (row != null) mergeSessionRowDurable(sessionId, row);
    } catch {} finally {
      sessionRowRefreshBySession.delete(sessionId);
    }
  })();
  sessionRowRefreshBySession.set(sessionId, task);
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    taskClock.dispose();
    workspaceBoot.cancel();
    sessionReadScope.reset();
    workspaceReadScope.reset();
    sessionViewsStore().stopSessionTimeClock();
  });
}

function toUiQuestion(q: AppQuestionRequest): UIQuestion {
  return {
    questionId: q.questionId,
    sessionId: q.sessionId,
    toolCallId: q.toolCallId,
    questions: q.questions.map((qi) => ({
      id: qi.id,
      question: qi.question,
      header: qi.header,
      body: qi.body,
      options: qi.options.map((o) => ({
        id: o.id,
        label: o.label,
        description: o.description,
      })),
      multiSelect: qi.multiSelect,
      allowOther: qi.allowOther,
      otherLabel: qi.otherLabel,
      otherDescription: qi.otherDescription,
    })),
  };
}

const bashCommandIndex = computed<Map<string, string>>(() => {
  const conversation = activeMainConversation();
  const index = new Map<string, string>();
  if (conversation === null) return index;
  for (const turn of conversation.view.turns) {
    for (const item of turn.items) {
      if (item.type !== 'tool_call' || (item.name !== 'Bash' && item.name !== 'bash')) continue;
      const input = item.input as { command?: unknown } | undefined;
      if (typeof input?.command !== 'string') continue;
      if (item.task_id !== undefined) index.set(item.task_id, input.command);
    }
  }
  return index;
});

function findBashCommandForTask(task: AppTask): string | undefined {
  return bashCommandIndex.value.get(task.id);
}

const agentPromptIndex = computed<Map<string, string | string[]>>(() => {
  const conversation = activeMainConversation();
  const index = new Map<string, string | string[]>();
  if (conversation === null) return index;
  for (const turn of conversation.view.turns) {
    for (const item of turn.items) {
      if (item.type !== 'tool_call') continue;
      const input = item.input as { prompt?: unknown; items?: unknown } | undefined;
      const prompt = typeof input?.prompt === 'string' ? input.prompt : undefined;
      if (prompt && !index.has(item.item_id)) index.set(item.item_id, prompt);
      const items = input?.items;
      if (!prompt && Array.isArray(items) && !index.has(item.item_id)) {
        const texts = items.filter((entry): entry is string => typeof entry === 'string');
        if (texts.length > 0) index.set(item.item_id, texts);
      }
    }
  }
  return index;
});

function findSubagentPromptForTask(task: AppTask): string | undefined {
  if (!task.parentToolCallId) return undefined;
  const entry = agentPromptIndex.value.get(task.parentToolCallId);
  if (Array.isArray(entry)) {
    return task.swarmIndex !== undefined ? entry[task.swarmIndex] : undefined;
  }
  return entry;
}

function toUiTask(task: AppTask): TaskItem {
  let state: TaskState;
  if (task.status === 'running') {
    state = 'run';
  } else if (task.status === 'completed') {
    state = 'done';
  } else if (task.status === 'cancelled') {
    state = 'cancelled';
  } else {
    state = 'fail';
  }

  let timing = '';
  let durationMs: number | undefined;
  if (task.status === 'running' && task.startedAt) {
    durationMs = Date.now() - new Date(task.startedAt).getTime();
    const elapsed = Math.round(durationMs / 1000);
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    timing = t('tasks.timingRunning', { time: `${m}:${String(s).padStart(2, '0')}` });
  } else if (task.completedAt && task.startedAt) {
    durationMs = new Date(task.completedAt).getTime() - new Date(task.startedAt).getTime();
    timing = t('tasks.timingDone', {
      time: formatTaskDuration(durationMs, {
        h: t('status.timeUnitHour'),
        m: t('status.timeUnitMinute'),
        s: t('status.timeUnitSecond'),
      }),
    });
  } else {
    timing = task.status;
  }

  const output: string[] | undefined =
    task.outputLines && task.outputLines.length > 0 ? task.outputLines : undefined;

  const command = task.command ?? findBashCommandForTask(task);
  const meta =
    task.kind === 'bash' && command
      ? `$ ${command}`
      : task.kind === 'subagent'
        ? (findSubagentPromptForTask(task) ?? task.subagentType)
        : undefined;

  return {
    id: task.id,
    agentId: task.agentId,
    name: task.description,
    kind: task.kind,
    state,
    timing,
    durationMs,
    meta,
    output,
    runInBackground: task.runInBackground,
    parentToolCallId: task.parentToolCallId,
    swarmIndex: task.swarmIndex,
    completedAt: task.completedAt,
    createdAt: task.createdAt,
    model: task.model,
    thinkingEffort: task.thinkingEffort,
  };
}

const workspace = computed<Workspace>(() => {
  const activeSession = rawState.sessions.find((s) => s.id === rawState.activeSessionId);
  const branch = activeSession ? activeSession.cwd.split('/').pop() ?? activeSession.cwd : 'main';
  return {
    name: rawState.workspaceName,
    branch,
  };
});

const sessions = computed<Session[]>(() => {
  void sessionViewsStore().sessionTimeClock;
  return rawState.sessions
    .toSorted((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .map((s) => ({
      id: s.id,
      title: s.title,
      time: formatTime(s.updatedAt),
      busy: sessionViewsStore().isMainTurnActive(s.id, s.mainTurnActive),
      pendingInteraction: s.pendingInteraction,
      lastTurnReason: s.lastTurnReason,
      workspaceId: workspaceIdForSession(s),
      cwd: s.cwd,
    }));
});

const activeSessionId = computed<string>(() => rawState.activeSessionId ?? '');

const skills = computed<AppSkill[]>(() => {
  const sid = rawState.activeSessionId;
  if (sid) return modelProvider.skillsBySession.value[sid] ?? [];
  const wid = activeWorkspaceId.value;
  return wid ? (modelProvider.skillsByWorkspace.value[wid] ?? []) : [];
});

const skillsLoaded = computed<boolean>(() => {
  const sid = rawState.activeSessionId;
  if (sid) return modelProvider.skillsFetchedBySession.value[sid] === true;
  const wid = activeWorkspaceId.value;
  return wid ? modelProvider.skillsFetchedByWorkspace.value[wid] === true : false;
});

const inFlight = computed<boolean>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return false;
  return promptStore().inFlightBySession[sid] ?? false;
});

const isStartingFirstPrompt = computed<boolean>(() => promptStore().isStartingFirstPrompt);
const sideChat = useSideChat(rawState, {
  api: getKimiWebApi(),
  conversations: auxiliaryConversations,
  pushOperationFailure: warningsStore().pushOperationFailure,
  nextOptimisticMsgId,
  resolveThinkingForPrompt: (sessionId, modelId) =>
    modelProvider.resolveThinkingForPrompt(sessionId, modelId),
  mapSendAuthFailure,
  ensureSideChatReady,
  onSideChatClosed: (sessionId, agentId) => {
    const approvals = approvalsStore();
    for (const approval of rawState.approvalsBySession[sessionId] ?? []) {
      if (approval.agentId === agentId) approvals.removePendingApproval(sessionId, approval.approvalId);
    }
    for (const question of rawState.questionsBySession[sessionId] ?? []) {
      if (question.agentId === agentId) approvals.removePendingQuestion(sessionId, question.questionId);
    }
  },
});

const activeAppTasks = computed<AppTask[]>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  const hiddenBtwAgentIds = new Set(
    (sideChat.sideChatTargetBySession.value[sid] ?? []).map((target) => target.agentId),
  );
  const hidesBtwRow = (agentId: string | undefined): boolean =>
    agentId !== undefined &&
    (hiddenBtwAgentIds.has(agentId) || sideChat.isClosedSideChatAgent(sid, agentId));
  return sessionTasksToAppTasks(tasksStore().tasksOf(sid, 'main'), sid).filter(
    (task) => !hidesBtwRow(task.agentId ?? task.id),
  );
});

const taskClock = useTaskClock(activeAppTasks);
const taskOutputStream = useTaskOutputStream({
  connection: () => {
    connectEventsIfNeeded();
    return getEventConn();
  },
});

const turnActive = computed<boolean>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return false;
  return mainTurnRunning(sid);
});

const activeTurnError = computed<AppTurnError | undefined>(() => {
  const conversation = activeMainConversation();
  if (conversation === null) return undefined;
  return conversationTurnError(conversation.view.turns.at(-1));
});

const activeTurnRetry = computed<AppTurnRetry | undefined>(() => {
  const conversation = activeMainConversation();
  return conversation === null ? undefined : conversationTurnRetry(conversation.view.turns.at(-1));
});

const activeTurnEnd = computed<Pick<ConversationTurnHeader, 'outcome' | 'end_reason'> | undefined>(() => {
  const last = activeMainConversation()?.view.turns.at(-1);
  return last?.status === 'ended' ? last : undefined;
});

const getFileUrlById = (fileId: string): string => getKimiWebApi().getFileUrl(fileId);
const getSessionMediaUrl = (sessionId: string, fileId: string): string =>
  getKimiWebApi().getSessionMediaUrl(sessionId, fileId);
function promptIdOf(message: AppMessage): string | undefined {
  const promptId = message.metadata?.['kimiWeb.promptId'];
  return typeof promptId === 'string' ? promptId : undefined;
}

function unechoedOptimisticMessages(sid: string): AppMessage[] {
  const optimistic = promptStore().optimisticMessagesBySession[sid] ?? [];
  if (optimistic.length === 0) return optimistic;
  const entry = mainConversationOf(sid);
  void entry?.version.value;
  const turns = entry?.view.turns ?? [];
  return optimistic.filter((message) => {
    const promptId = promptIdOf(message);
    return promptId === undefined || findPromptMessage(turns, promptId) === undefined;
  });
}

function pruneEchoedPrompts(sid: string): void {
  const unechoed = unechoedOptimisticMessages(sid);
  if (unechoed.length !== (promptStore().optimisticMessagesBySession[sid]?.length ?? 0)) {
    promptStore().setOptimisticMessages(sid, unechoed);
  }
}

const mainConversationProjector = createConversationProjector();
const turns = computed<ChatTurn[]>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  const conversation = activeMainConversation();
  if (conversation === null) return [];
  const options = {
    sessionId: sid,
    getFileUrl: getFileUrlById,
    getSessionMediaUrl,
    swarmMode: modeStore().swarmModeBySession[sid] ?? false,
  };
  const base = mainConversationProjector(conversation.view.turns, options);
  const held = promptStore().heldFirstPromptBySession[sid];
  const unechoed = unechoedOptimisticMessages(sid);
  const uncovered = held === undefined ? unechoed : [held, ...unechoed];
  if (uncovered.length === 0) return base;
  const startNo = base.filter((turn) => turn.role !== 'compaction').length + 1;
  return [...base, ...uncovered.map((msg, index) => pendingPromptTurn(msg, startNo + index, options))];
});

const promptPending = computed<boolean>(() => {
  const sid = rawState.activeSessionId;
  return sid !== undefined && unechoedOptimisticMessages(sid).length > 0;
});

const continuePending = computed<boolean>(() => {
  const sid = rawState.activeSessionId;
  return sid !== undefined && promptStore().isContinueTurnStarting(sid);
});

const working = computed<boolean>(
  () => inFlight.value || turnActive.value || promptPending.value || continuePending.value,
);

watch(
  [() => rawState.activeSessionId, working],
  ([sid, isWorking]) => {
    if (sid !== undefined && isWorking) openSessionBusyWindow(sid);
    else closeSessionBusyWindow();
  },
);

watch(
  () => rawState.sessions.map((s) => s.id),
  (ids, previous) => {
    const known = new Set(previous);
    for (const id of ids) {
      if (known.has(id)) continue;
      resyncMainAgentState(id);
      const usage = agentStatesStore().usageOf(id, MAIN_AGENT_ID);
      if (usage !== undefined) applyMainAgentUsage(id, usage);
    }
  },
);

watch(
  () => rawState.activeSessionId,
  (sid, prevSid) => {
    sessionReadScope.activate(sid);
    if (sid) mainConversations.activate(sid, MAIN_AGENT_ID);
    if (prevSid !== undefined && prevSid !== sid) mainConversations.deactivate(prevSid, MAIN_AGENT_ID);
  },
  { immediate: true },
);

function observeMainRating(sessionId: string): void {
  const last = mainTurnsOf(sessionId).findLast((turn) => turn.kind === 'agent');
  sessionRatingStore().observeTurn(sessionId, last?.turn_id, last?.status === 'running');
}

const turnPhasesByEntry = new WeakMap<ConversationEntry, Map<string, 'running' | 'settled'>>();

function turnPhasesOf(entry: ConversationEntry): Map<string, 'running' | 'settled'> {
  let phases = turnPhasesByEntry.get(entry);
  if (phases === undefined) {
    phases = new Map();
    turnPhasesByEntry.set(entry, phases);
  }
  return phases;
}

function onMainPage(entry: ConversationEntry, previous: readonly ConversationTurn[], initial: boolean): void {
  const sessionId = entry.sessionId;
  settleMainCompaction(entry, initial);
  if (!initial) {
    if (promptStore().hasUnsettledCompaction(sessionId) && !mainCompacting(sessionId)) {
      settleCompaction(sessionId, 'cancelled', undefined);
    }
    clearTurnFileHistorySession(sessionId);
  }
  const phases = turnPhasesOf(entry);
  const frontier = initial ? Infinity : Math.max(-1, ...previous.map((turn) => turn.ordinal));
  const pending = new Set((promptStore().optimisticMessagesBySession[sessionId] ?? []).map(promptIdOf));
  for (const turn of entry.view.turns) {
    const phase = phases.get(turn.turn_id);
    const opener = openerPromptId(turn);
    const ours = opener !== undefined && pending.has(opener);
    const fresh = phase === 'running' || (phase === undefined && (turn.ordinal > frontier || ours));
    if (turn.status === 'running') phases.set(turn.turn_id, 'running');
    else if (fresh) settleMainTurnEnd(entry, turn);
    else phases.set(turn.turn_id, 'settled');
  }
  if (initial || mainTurnRunning(sessionId) || promptStore().inFlightBySession[sessionId] === true || promptStore().isSteerInFlight(sessionId)) {
    pruneEchoedPrompts(sessionId);
    return;
  }
  promptStore().clearOptimisticMessages(sessionId);
  promptPipeline.resumeQueueIfIdle(sessionId);
}

function onMainTurnsRemoved(entry: ConversationEntry, turnIds: readonly string[]): void {
  promptStore().settleContinueTurnStart(entry.sessionId);
  const phases = turnPhasesOf(entry);
  for (const turnId of turnIds) phases.delete(turnId);
  clearTurnFileHistorySession(entry.sessionId);
  pruneEchoedPrompts(entry.sessionId);
}

function onMainTurnStarted(entry: ConversationEntry, turn: ConversationTurn): void {
  promptPredictionController.handleTurnStarted(entry.sessionId);
  turnPhasesOf(entry).set(turn.turn_id, 'running');
  scheduleSessionRowRefresh(entry.sessionId);
}

function onMainTurnEnded(entry: ConversationEntry, turn: ConversationTurn): void {
  if (turnPhasesOf(entry).get(turn.turn_id) === 'running') settleMainTurnEnd(entry, turn);
}

function settleMainTurnEnd(entry: ConversationEntry, turn: ConversationTurn): void {
  const sessionId = entry.sessionId;
  promptStore().settleContinueTurnStart(sessionId);
  turnPhasesOf(entry).set(turn.turn_id, 'settled');
  pruneEchoedPrompts(sessionId);
  promptPipeline.resumeQueueIfIdle(sessionId);
  if (turn.kind !== 'agent') return;
  scheduleSessionRowRefresh(sessionId);
  onMainTurnEnd(sessionId, turnResult(turn) === 'completed' ? 'idle' : 'aborted', {
    firstTurn: turn.ordinal === 0,
    promptId: openerPromptId(turn),
    ratingTurnId: turn.turn_id,
    predictionSourceId: turn.turn_id,
    predictionTurnId: turn.ordinal,
    continuation: turn.continuation,
  });
}

function onMainNotice(sessionId: string, notice: ConversationNotice): void {
  if (notice.code === 'model.not_configured') {
    rawState.unavailableModelBySession = { ...rawState.unavailableModelBySession, [sessionId]: notice.title };
    void confirm({
      title: t('warnings.modelUnavailable.title'),
      message: t('warnings.modelUnavailable.message', { model: notice.title }),
      confirmLabel: t('warnings.modelUnavailable.change'),
      variant: 'primary',
      action: () => openModelPicker(sessionId),
    });
    return;
  }
  if (notice.code === 'compaction.cancelled') {
    if (failedCompactionSettled.delete(sessionId)) {
      failedCompactionErrorDue.add(sessionId);
      return;
    }
    settleCompaction(sessionId, 'cancelled', undefined);
  }
  warningsStore().markSessionWarningShown(sessionId, `${notice.code ?? ''} ${notice.title}`);
  if (notice.level === 'error') {
    const compactionFailure = failedCompactionErrorDue.delete(sessionId);
    if (!compactionFailure && isModelTurnErrorNotice(notice)) return;
    if (sessionId === rawState.activeSessionId) return;
    const toast = buildAgentErrorNotice(notice, t);
    warningsStore().pushWarning(compactionFailure ? { ...toast, title: t('warnings.agentError.compactionFailed') } : toast);
    return;
  }
  warningsStore().pushWarning({ severity: notice.level, title: t('warnings.noteLabel'), message: notice.title });
}
const tasks = computed<TaskItem[]>(() => {
  void taskClock.tick.value;
  const items = activeAppTasks.value.map(toUiTask);
  const sid = rawState.activeSessionId;
  if (sid) {
    const runtime = sessionRuntimeStore().runtimeFor(sid);
    let serials = runtime.subagentCardSerials;
    if (!serials) {
      serials = new Map();
      runtime.subagentCardSerials = serials;
    }
    const cards = items.filter((item) => item.kind === 'subagent' && item.runInBackground);
    const unnumbered = cards
      .filter((item) => !serials.has(item.agentId ?? item.id))
      .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
    let next = serials.size === 0 ? 0 : Math.max(...serials.values()) + 1;
    for (const item of unnumbered) serials.set(item.agentId ?? item.id, next++);
    for (const item of cards) item.swarmIndex = serials.get(item.agentId ?? item.id);
  }
  return items;
});

const swarms = computed<SwarmGroup[]>(() => buildSwarmGroups(activeAppTasks.value));
const swarmMembersByToolCallId = computed<Map<string, SwarmMember[]>>(() =>
  swarmMembersByToolCall(activeAppTasks.value),
);

const goal = computed<AppGoal | null>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return null;
  return rawState.goalBySession[sid] ?? null;
});

const todos = computed<TodoView[]>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  return agentStatesStore()
    .todosOf(sid, MAIN_AGENT_ID)
    .map((item) => ({ title: item.title, status: item.status }));
});

const isMainCompactingOrStarting = (sessionId: string): boolean =>
  mainCompacting(sessionId) || promptStore().isCompactStarting(sessionId);

const compaction = computed<CompactionStatus | null>(() => {
  const sid = rawState.activeSessionId;
  return sid && isMainCompactingOrStarting(sid) ? { status: 'running' } : null;
});

const connection = computed<ConnectionState>(() => connectionStore().connection);

const loading = computed<boolean>(() => rawState.loading);
const sessionLoading = computed<boolean>(() => rawState.sessionLoading);
const loadingMoreMessages = computed<boolean>(() => activeMainConversation()?.loadingOlder ?? false);
const hasMoreMessages = computed<boolean>(() => activeMainConversation()?.view.hasMore === true);
const loadMoreMessagesError = computed<boolean>(() => activeMainConversation()?.loadOlderError ?? false);
const serverVersion = computed<string>(() => rawState.serverVersion);
const webTitle = computed<string>(() => rawState.webTitle);
const experimentalFlags = computed<Record<string, boolean>>(() => rawState.experimentalFlags);
const backend = computed<'v1' | 'v2'>(() => rawState.backend);
const dangerousBypassAuth = computed<boolean>(() => rawState.dangerousBypassAuth);

function clearDangerousBypassAuth(): void {
  rawState.dangerousBypassAuth = false;
}

const permission = computed<PermissionMode | undefined>(() => permissionsStore().forActive());
const thinking = computed<ThinkingLevel | undefined>(() => rawState.thinking);
const planMode = computed<boolean>(() => modeStore().planMode);
const planArmed = computed<boolean>(() => modeStore().planArmed);
const swarmMode = computed<boolean>(() => modeStore().swarmMode);
const towerMode = computed<boolean>(() => modeStore().towerMode);
const goalMode = computed<boolean>(() => modeStore().goalMode);

const sessionPlans = computed<Record<string, SessionPlan>>(() => {
  const conversation = activeMainConversation();
  return conversation === null ? {} : sessionPlansOf(conversation.view.turns);
});

const activationBadges = computed<ActivationBadges>(() => {
  const swarmCounts = countSwarmMembers(swarms.value);
  return {
    plan: planMode.value,
    goal: goal.value && goal.value.status !== 'complete'
      ? {
          status: goal.value.status,
          turnsUsed: goal.value.turnsUsed,
          elapsedMs: goal.value.wallClockMs,
        }
      : null,
    swarm: swarmCounts.total > 0 ? swarmCounts : null,
  };
});

const queued = computed<QueuedPromptView[]>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  const api = getKimiWebApi();
  return (promptStore().queuedBySession[sid] ?? []).map((q) => ({
    id: q.id ?? q.text,
    text: q.text,
    attachmentCount: q.attachments?.length ?? 0,
    attachments: q.attachments?.map((a) => promptAttachmentToTurnAttachment(api, a)),
    editText: q.editText,
    snapshot: q.snapshot,
    kind: q.kind,
    instruction: q.instruction,
  }));
});

const warnings = computed<AppWarning[]>(() => rawState.warnings);

const questions = computed<UIQuestion[]>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  return (rawState.questionsBySession[sid] ?? []).map(toUiQuestion);
});

const pendingApprovals = computed<
  { approvalId: string; block: ApprovalBlock; agentName?: string; toolCallId?: string }[]
>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  const tasks = tasksStore().tasksOf(sid, 'main');
  return (rawState.approvalsBySession[sid] ?? []).map((a) => ({
    approvalId: a.approvalId,
    block: buildApprovalBlock(a),
    agentName: a.agentId !== undefined && a.agentId !== 'main' ? subagentDisplayName(tasks, a.agentId) : undefined,
    toolCallId: a.toolCallId,
  }));
});

const activity = computed<ActivityState>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return 'idle';

  const approvals = rawState.approvalsBySession[sid] ?? [];
  if (approvals.length > 0) return 'awaiting-approval';

  const questionList = rawState.questionsBySession[sid] ?? [];
  if (questionList.length > 0) return 'awaiting-question';

  if (working.value) return 'running';

  return 'idle';
});

const modelProvider = useModelProviderState(rawState, {
  api: getKimiWebApi(),
  pushOperationFailure: warningsStore().pushOperationFailure,
  persistSessionProfile,
  whenSessionProfileSettled,
  savePlanModeToStorage: () => modeStore().savePlanModeToStorage(),
  saveTowerModeToStorage: () => modeStore().saveTowerModeToStorage(),
  activity,
  updateSession,
  loadConfig: () => configStore().loadConfig(),
  checkAuth: () => authStore().checkAuth(),
  mapSendAuthFailure,
});

const gitInfo = computed<{ branch: string; ahead: number; behind: number } | null>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return null;
  const gs = rawState.gitStatusBySession[sid];
  if (!gs) return null;
  return { branch: gs.branch, ahead: gs.ahead, behind: gs.behind };
});

const activePullRequest = computed<{ number: number; state: string; url: string } | null>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return null;
  return rawState.gitStatusBySession[sid]?.pullRequest ?? null;
});

const changes = computed<{ path: string; status: string }[]>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  const gs = rawState.gitStatusBySession[sid];
  if (!gs) return [];
  return Object.entries(gs.entries)
    .map(([path, status]) => ({ path, status }))
    .sort((a, b) => a.path.localeCompare(b.path));
});

const gitDiffStats = computed<{ totalAdditions: number; totalDeletions: number } | null>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return null;
  const gs = rawState.gitStatusBySession[sid];
  if (!gs) return null;
  return { totalAdditions: gs.additions, totalDeletions: gs.deletions };
});

const status = computed<ConversationStatus>(() => {
  const activeSession = rawState.sessions.find((s) => s.id === rawState.activeSessionId);
  const branch =
    gitInfo.value?.branch ??
    (activeSession ? activeSession.cwd.split('/').pop() ?? activeSession.cwd : 'main');
  const unavailable = activeSession !== undefined && rawState.unavailableModelBySession?.[activeSession.id] !== undefined;
  const rawModel = unavailable ? '—' : modelsStore().resolveSendModel(activeSession?.model, { includeDraft: activeSession === undefined }) ?? '—';

  const matched =
    modelProvider.models.value.find((m) => m.id === rawModel) ??
    modelProvider.models.value.find((m) => m.model === rawModel);
  const displayModel =
    matched?.displayName ||
    matched?.model ||
    (rawModel.includes('/') ? rawModel.split('/').pop()! : rawModel);

  return {
    model: displayModel,
    modelId: matched?.id ?? rawModel,
    ctxUsed: activeSession?.usage.contextTokens ?? 0,
    ctxMax: activeSession?.usage.contextLimit ?? 0,
    permission: permissionsStore().forActive(),
    branch,
    cwd: activeSession?.cwd ?? '',
    isGitRepo: gitInfo.value !== null,
  };
});

const fileDiff = computed<DiffViewLine[]>(() => filesStore().fileDiffLines);

const sessionCost = computed<number>(() => {
  const activeSession = rawState.sessions.find((s) => s.id === rawState.activeSessionId);
  return activeSession?.usage.totalCostUsd ?? 0;
});

const modelsReady = computed<boolean>(() => modelsStore().modelsReady);
const defaultModel = computed<string | null>(() => modelsStore().defaultModel);
const presetCatalogProviders = computed<AppCatalogProvider[]>(() => modelsStore().catalogProviders);
const presetCatalogState = computed(() => modelsStore().catalogState);
const managedProviderStatus = computed<string | null>(() => authStore().managedProviderStatus);
const managedUserInfo = computed<ManagedUserInfo | null>(() => authStore().managedUserInfo);
const managedMembership = computed<ManagedMembership>(() => authStore().managedMembership);
const config = computed<AppConfig | null>(() => rawState.config);

function resolveGateChatModel(
  sessionModel: string | null | undefined,
  opts?: { includeDraft?: boolean },
): { chatModel: string | null; chatModelManaged: boolean } {
  const store = modelsStore();
  const chatModel = store.resolveSendModel(sessionModel, opts);
  const entry =
    chatModel === null
      ? undefined
      : store.activeModels.find((m) => m.id === chatModel || m.model === chatModel);
  return { chatModel, chatModelManaged: entry?.provider === MANAGED_KIMI_CODE_PROVIDER_ID };
}

function chatHostId(sessionId = rawState.activeSessionId): string | undefined {
  const session = rawState.sessions.find((row) => row.id === sessionId);
  const workspaces = workspacesStore();
  const workspaceId = session === undefined ? workspaces.activeWorkspaceId : workspaces.workspaceIdForSession(session);
  return session?.hostId ?? (workspaceId === null ? undefined : workspaces.workspaceById.get(workspaceId)?.hostId);
}

function gateVerdictInput(): ChatGateInput {
  const activeSession = rawState.activeSessionId
    ? rawState.sessions.find((s) => s.id === rawState.activeSessionId)
    : undefined;
  return {
    ...resolveGateChatModel(
      activeSession !== undefined && rawState.unavailableModelBySession?.[activeSession.id] !== undefined ? null : activeSession?.model,
      { includeDraft: activeSession === undefined },
    ),
    modelsReady: modelsStore().modelsReady,
    hasModels: modelsStore().hasModels,
    signedIn: authStore().signedIn,
    isFree: authStore().isFree,
  };
}

function activeSessionModelUnknown(): boolean {
  const sid = rawState.activeSessionId;
  if (sid === null || sid === undefined) return false;
  const row = rawState.sessions.find((s) => s.id === sid);
  if (row === undefined || row.model !== '') return false;
  return rawState.sessionStatusSettledBySession[sid] !== true;
}

const chatGateVerdict = computed<ChatGateVerdict>(() => {
  if (chatHostId() !== undefined) return 'ok';
  const verdict = computeGateVerdict(gateVerdictInput());
  if (verdict === 'pick-model' && activeSessionModelUnknown()) return 'ok';
  return verdict;
});

export type EnsureChatReadyResult = ChatGateVerdict | 'server-auth-required';

const MODEL_SWITCH_COMPACT_TIMEOUT_MS = 10 * 60 * 1000;

let modelSelectSequence = 0;
const modelSelectGenerationBySession = new Map<string | null | undefined, number>();

function beginModelSelect(sessionId: string | null | undefined): number {
  modelSelectSequence += 1;
  modelSelectGenerationBySession.set(sessionId, modelSelectSequence);
  return modelSelectSequence;
}

async function applySelectModel(modelId: string): Promise<void> {
  const hostId = chatHostId();
  const switched = await modelProvider.setModel(modelId);
  if (switched && hostId === undefined && modelId !== defaultModel.value) {
    void configStore().updateConfig({ defaultModel: modelId });
  }
}

function matchedModelSwitchRuleForActiveSession(
  modelId: string,
): { rule: ModelSwitchRule; fromDisplay: string; toDisplay: string; sessionType: 'old' | 'new' } | undefined {
  const sid = rawState.activeSessionId;
  const session = sid === null || sid === undefined ? undefined : rawState.sessions.find((s) => s.id === sid);
  if (sid !== null && sid !== undefined && session === undefined) return undefined;
  const store = modelsStore();
  const fromModel = session === undefined ? store.resolveSendModel(undefined, { includeDraft: true }) : session.model;
  if (fromModel === null || fromModel === modelId) return undefined;
  const fromEntry = store.activeModels.find((m) => m.id === fromModel);
  const toEntry = store.activeModels.find((m) => m.id === modelId);
  if (fromEntry === undefined || toEntry === undefined) return undefined;
  const configModels = configStore().config?.models;
  const fromUpstream = upstreamModelIdFromConfigModels(configModels, fromModel);
  const toUpstream = upstreamModelIdFromConfigModels(configModels, modelId);
  if (fromUpstream === undefined || toUpstream === undefined) return undefined;
  const hasConversationHistory =
    session !== undefined &&
    (session.lastPrompt !== undefined || session.messageCount > 0 || session.usage.turnCount > 0);
  const sessionType = hasConversationHistory ? 'old' : 'new';
  const rule = matchModelSwitchRule(modelSwitchConfirmStore().peek(), fromUpstream, toUpstream, sessionType);
  if (rule === undefined) return undefined;
  return {
    rule,
    fromDisplay: fromEntry.displayName ?? fromEntry.model,
    toDisplay: toEntry.displayName ?? toEntry.model,
    sessionType,
  };
}

async function runModelSwitchAction(
  action: ModelSwitchAction,
  modelId: string,
  triggerSid: string | null | undefined,
  generation: number,
): Promise<void> {
  const isSuperseded = () =>
    modelSelectGenerationBySession.get(triggerSid) !== generation || rawState.activeSessionId !== triggerSid;
  switch (action) {
    case 'cancel':
      return;
    case 'continue':
      if (isSuperseded()) return;
      await applySelectModel(modelId);
      return;
    case 'compact': {
      if (triggerSid === null || triggerSid === undefined) {
        if (isSuperseded()) return;
        await applySelectModel(modelId);
        return;
      }
      const sid = triggerSid;
      if (isSuperseded()) return;
      const fromModel = rawState.sessions.find((s) => s.id === sid)?.model;
      const request = sessionActions.compact(
        undefined,
        modelSwitchConfirmStore().hasCompactionWait(sid)
          ? undefined
          : {
              onRequestRejected: () =>
                modelSwitchConfirmStore().noteCompactionSettled(sid, 'request-failed'),
            },
      );
      if (request === undefined) {
        warningsStore().pushOperationFailure('compact', new Error('compact request was not sent'), {
          sessionId: sid,
        });
        return;
      }
      const outcome = await modelSwitchConfirmStore().waitCompactionSettled(sid, MODEL_SWITCH_COMPACT_TIMEOUT_MS);
      try {
        if (outcome === 'request-failed') return;
        if (modelSelectGenerationBySession.get(sid) !== generation) return;
        if (outcome === 'completed') {
          const session = rawState.sessions.find((s) => s.id === sid);
          if (session === undefined || session.model !== fromModel) return;
          if (rawState.activeSessionId === sid) {
            await applySelectModel(modelId);
          } else {
            await modelProvider.setSessionModel(sid, modelId);
          }
          return;
        }
        warningsStore().pushOperationFailure(
          'modelSwitch',
          new Error(`compaction ${outcome}`),
          { sessionId: sid, message: t('model.switchCompactAborted') },
        );
      } finally {
        promptPipeline.resumeAfterCompaction(sid);
      }
    }
  }
}

async function selectModel(modelId: string): Promise<void> {
  const triggerSid = rawState.activeSessionId;
  const generation = beginModelSelect(triggerSid);
  const readiness: Promise<unknown>[] = [];
  if (modelSwitchConfirmStore().needsLoad()) readiness.push(modelSwitchConfirmStore().refresh());
  if (configStore().config === null) readiness.push(configStore().loadConfig());
  if (readiness.length > 0) {
    await Promise.all(readiness);
    if (modelSelectGenerationBySession.get(triggerSid) !== generation || rawState.activeSessionId !== triggerSid) return;
  }
  const matched = matchedModelSwitchRuleForActiveSession(modelId);
  if (matched === undefined) {
    await applySelectModel(modelId);
    return;
  }
  const action = await modelSwitchConfirmStore().requestConfirm({
    fromModel: matched.fromDisplay,
    toModel: matched.toDisplay,
    sessionType: matched.sessionType,
    hint: resolveModelSwitchHint(matched.rule, detectKimiLocale()),
    warning: resolveModelSwitchWarning(matched.rule, detectKimiLocale()),
  });
  await runModelSwitchAction(action, modelId, triggerSid, generation);
}

function effortModelIdForSession(sessionId: string | null | undefined): string | undefined {
  const store = modelsStore();
  const activeSession = sessionId
    ? rawState.sessions.find((session) => session.id === sessionId)
    : undefined;
  const rawModel =
    activeSession === undefined
      ? store.draftModel ?? store.activeDefaultModel
      : activeSession.model || store.activeDefaultModel;
  if (rawModel === null || rawModel === undefined || rawModel.length === 0) return undefined;
  return (
    store.activeModels.find((model) => model.id === rawModel)?.id ??
    store.activeModels.find((model) => model.model === rawModel)?.id ??
    rawModel
  );
}

let effortSelectGeneration = 0;

async function setThinking(level: ThinkingLevel): Promise<void> {
  effortSelectGeneration += 1;
  const generation = effortSelectGeneration;
  const triggerSid = rawState.activeSessionId;
  const triggerModelId = effortModelIdForSession(triggerSid);
  const fromThinking = rawState.thinking;
  const store = modelsStore();
  const modelEntry = store.activeModels.find((model) => model.id === triggerModelId);
  if (modelEntry?.provider !== MANAGED_KIMI_CODE_PROVIDER_ID) {
    modelProvider.setThinking(level);
    return;
  }
  const fromEffort = effectiveThinkingLevel(modelEntry, fromThinking);
  if (fromEffort === level) {
    modelProvider.setThinking(level);
    return;
  }
  const isStale = () =>
    generation !== effortSelectGeneration ||
    rawState.activeSessionId !== triggerSid ||
    effortModelIdForSession(triggerSid) !== triggerModelId ||
    rawState.thinking !== fromThinking;
  if (effortSwitchStore().needsLoad()) await effortSwitchStore().refresh();
  if (isStale()) return;
  const activeSession = rawState.sessions.find((session) => session.id === triggerSid);
  const currentModel = store.activeModels.find((model) => model.id === triggerModelId);
  if (currentModel?.provider !== MANAGED_KIMI_CODE_PROVIDER_ID) {
    modelProvider.setThinking(level);
    return;
  }
  const hasConversationHistory =
    activeSession !== undefined &&
    (activeSession.lastPrompt !== undefined || activeSession.messageCount > 0 || activeSession.usage.turnCount > 0);
  const sessionType = hasConversationHistory ? 'old' : 'new';
  const rule = matchEffortSwitchRule(effortSwitchStore().peek(), fromEffort, level, sessionType);
  if (rule === undefined) {
    modelProvider.setThinking(level);
    return;
  }
  const action = await effortSwitchStore().requestConfirm({
    fromEffort,
    toEffort: level,
    sessionType,
    hint: resolveModelSwitchHint(rule, detectKimiLocale()),
    warning: resolveModelSwitchWarning(rule, detectKimiLocale()),
  });
  if (action === 'continue' && !isStale()) modelProvider.setThinking(level);
}

let ensureChatReadyFlight: { sid: string | undefined; promise: Promise<EnsureChatReadyResult> } | null = null;
function ensureChatReady(): Promise<EnsureChatReadyResult> {
  const sid = rawState.activeSessionId;
  if (ensureChatReadyFlight !== null && ensureChatReadyFlight.sid === sid) {
    return ensureChatReadyFlight.promise;
  }
  const promise = runEnsureChatReady();
  ensureChatReadyFlight = { sid, promise };
  return promise.finally(() => {
    if (ensureChatReadyFlight?.promise === promise) ensureChatReadyFlight = null;
  });
}

async function runEnsureChatReady(): Promise<EnsureChatReadyResult> {
  if (chatHostId() !== undefined) return 'ok';
  const pendingSid = rawState.activeSessionId;
  if (pendingSid !== null && pendingSid !== undefined) {
    const row = rawState.sessions.find((s) => s.id === pendingSid);
    if (row !== undefined && row.model === '') await whenSessionStatusSettled(pendingSid);
  }
  const early = gateVerdictInput();
  if (early.chatModel !== null) {
    if (early.chatModelManaged && early.signedIn && authStore().managedMembership !== 'member') {
      await authStore().probeMembership();
    }
    const earlyVerdict = computeGateVerdict(gateVerdictInput());
    if (earlyVerdict === 'ok' || earlyVerdict === 'upgrade') return earlyVerdict;
  }
  const [authResult, catalogOk, configOutcome] = await Promise.all([
    authStore().checkAuth(),
    modelProvider.loadModels(),
    configStore().loadConfig(),
  ]);
  if (authResult === 'retry' || catalogOk === false || configOutcome === 'failed') return 'ok';
  if (authResult === 'server-auth-required') return 'server-auth-required';
  let verdict = computeGateVerdict(gateVerdictInput());
  if (verdict !== 'upgrade' && verdict !== 'configure-model') return verdict;
  await authStore().probeMembership();
  verdict = computeGateVerdict(gateVerdictInput());
  if (verdict !== 'configure-model') return verdict;
  const refreshed = await modelProvider.refreshOAuthProviderModels();
  if (!refreshed.ok) return 'configure-model';
  return computeGateVerdict(gateVerdictInput());
}

async function ensureSideChatReady(sid: string): Promise<EnsureChatReadyResult> {
  if (chatHostId(sid) !== undefined) return 'ok';
  let verdict: EnsureChatReadyResult;
  if (sid === rawState.activeSessionId) {
    verdict = await ensureChatReady();
  } else {
    const [authResult, catalogOk, configOutcome] = await Promise.all([
      authStore().checkAuth(),
      modelProvider.loadModels(),
      configStore().loadConfig(),
    ]);
    if (authResult === 'retry' || catalogOk === false || configOutcome === 'failed') return 'ok';
    if (authResult === 'server-auth-required') return 'server-auth-required';
    const input = gateVerdictInput();
    Object.assign(
      input,
      resolveGateChatModel(rawState.sessions.find((s) => s.id === sid)?.model),
    );
    verdict = computeGateVerdict(input);
  }
  if (verdict !== 'ok' && verdict !== 'server-auth-required') {
    sendFailureMapGeneration += 1;
    sendFailureVerdict.value = { verdict, sessionId: sid };
  }
  return verdict;
}

const sendFailureVerdict = ref<{ verdict: ChatGateVerdict; sessionId?: string } | null>(null);
let sendFailureMapGeneration = 0;
function dismissSendFailureVerdict(): void {
  sendFailureVerdict.value = null;
}

async function mapSendAuthFailure(err: unknown, sid?: string): Promise<ChatGateVerdict | null> {
  if (chatHostId(sid) !== undefined) return null;
  const initial = mapDaemonAuthError(err, { hasModels: modelsStore().hasModels });
  if (initial === null) return null;
  const generation = ++sendFailureMapGeneration;
  let verdict = initial;
  if (isDaemonApiError(err) && err.code === AUTH_MODEL_NOT_RESOLVED_CODE) {
    const catalogOk = await modelProvider.loadModels();
    const configOk = (await configStore().loadConfig()) !== 'failed';
    const authResult = await authStore().checkAuth();
    if (catalogOk && !modelsStore().hasModels) {
      verdict = 'configure-model';
    } else if (catalogOk && configOk && authResult === 'proceed') {
      const input = gateVerdictInput();
      if (sid !== undefined && sid !== rawState.activeSessionId) {
        Object.assign(
          input,
          resolveGateChatModel(rawState.sessions.find((s) => s.id === sid)?.model),
        );
      }
      verdict = computeGateVerdict(input);
    }
  }
  if (generation === sendFailureMapGeneration) {
    sendFailureVerdict.value = sid === undefined ? { verdict } : { verdict, sessionId: sid };
  }
  return verdict;
}

const changesByPath = computed<Record<string, string>>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return {};
  const gs = rawState.gitStatusBySession[sid];
  if (!gs) return {};
  return { ...gs.entries };
});

const workspacesView = computed<WorkspaceView[]>(() => workspacesStore().workspacesView);

const activeWorkspaceId = computed<string | null>(() => workspacesStore().activeWorkspaceId);
const visibleWorkspace = computed<WorkspaceView | null>(() => workspacesStore().visibleWorkspace);

const SESSION_MENTION_SEARCH_PAGE_SIZE = 50;

function mentionCandidatesFrom(sessions: readonly AppSession[]): SessionMentionCandidate[] {
  return buildSessionMentionCandidates({
    sessions,
    activeSessionId: rawState.activeSessionId,
    activeWorkspaceId: activeWorkspaceId.value,
    workspaceName: (id) => workspacesView.value.find((workspace) => workspace.id === id)?.name,
    formatTime,
  });
}

const sessionMentionsAvailable = computed(
  () => useSessionMentions().sessionMentions.value && visibleWorkspace.value?.hostId === undefined,
);

const sessionMentionCandidates = computed<SessionMentionCandidate[]>(() => {
  if (!sessionMentionsAvailable.value) return [];
  void sessionViewsStore().sessionTimeClock;
  return mentionCandidatesFrom(rawState.sessions);
});

async function searchSessionMentions(query: string, options: { signal: AbortSignal }): Promise<SessionMentionCandidate[]> {
  if (!sessionMentionsAvailable.value) return [];
  const page = await getKimiWebApi().listSessions(
    { query, pageSize: SESSION_MENTION_SEARCH_PAGE_SIZE, hasPrompt: true, localOnly: true },
    options,
  );
  return mentionCandidatesFrom(page.items);
}

const activeWorkspaceTrust = computed<boolean | undefined>(() => {
  const store = workspacesStore();
  const id = store.activeWorkspaceId;
  if (!id || !Object.prototype.hasOwnProperty.call(store.trustByWorkspaceId, id)) return undefined;
  return store.trustByWorkspaceId[id];
});

const activeWorkspaceTrustError = computed(() => {
  const store = workspacesStore();
  const id = store.activeWorkspaceId;
  return id === null ? undefined : store.trustErrorByWorkspaceId[id];
});

const activeWorkspaceTrustLoading = computed<boolean>(() => {
  const store = workspacesStore();
  const id = store.activeWorkspaceId;
  return id !== null && store.trustLoadingByWorkspaceId[id] === true;
});

const workspaceSortMode = computed<WorkspaceSortMode>(() => workspacesStore().workspaceSortMode);

function workspaceIdForSession(s: { workspaceId?: string; cwd: string }): string {
  return workspacesStore().workspaceIdForSession(s);
}

function setWorkspaceSortMode(mode: WorkspaceSortMode): void {
  workspacesStore().setWorkspaceSortMode(mode);
}

function reorderWorkspaces(ids: string[]): void {
  workspacesStore().reorderWorkspaces(ids);
}

function togglePinWorkspace(id: string): void {
  workspacesStore().togglePinWorkspace(id);
}

function pinWorkspace(id: string, target?: PinnedInsertTarget): void {
  workspacesStore().pinWorkspace(id, target);
}

function reorderPinned(fromKey: string, toKey: string, position: DropPosition): void {
  pinnedOrderStore().reorder(fromKey, toKey, position);
}

watch(
  () => rawState.config,
  (config) => {
    if (config === null) return;
    permissionsStore().setDaemonDefault(permissionModeFromConfig(config.defaultPermissionMode));
  },
  { immediate: true },
);

watch(
  () =>
    [
      workspacesStore().mergedWorkspaces.map((w) => w.id).join('\0'),
      rawState.loading,
      hostsStore().loaded && hostsStore().hosts.every((host) => host.status === 'ready'),
    ] as const,
  ([idsKey, loading, everyHostListed]) => {
    if (loading || !everyHostListed) return;
    const current = idsKey ? idsKey.split('\0') : [];
    workspacesStore().reconcileOrder(current);
  },
);

function pinSession(id: string, target?: PinnedInsertTarget): void {
  sessionsStore().pinSession(id, target);
}

function unpinSession(id: string): void {
  sessionsStore().unpinSession(id);
}

function unpinSessions(ids: string[]): void {
  sessionsStore().unpinSessions(ids);
}

function togglePinSession(id: string): void {
  sessionsStore().togglePinSession(id);
}

async function ensureWorkspaceTrust(id: string, options?: ReadRequestOptions) {
  const result = await workspacesStore().ensureWorkspaceTrust(id, options);
  if (
    result.status === 'success' &&
    result.trusted &&
    activeWorkspaceId.value === id &&
    options?.signal?.aborted !== true &&
    !Object.prototype.hasOwnProperty.call(modelProvider.skillsByWorkspace.value, id)
  ) {
    void modelProvider.loadSkillsForWorkspace(id, options);
  }
  return result;
}

function observeWorkspace(id: string | null): void {
  workspaceReadScope.activate(id ?? undefined);
  if (!id) return;
  void ensureWorkspaceTrust(id, workspaceReadScope.options(id));
}

watch(activeWorkspaceId, observeWorkspace, { immediate: true });

const browserTabTitle = useBrowserTabTitle();

const activeSessionTitleForTab = computed<string>(() => {
  const id = rawState.activeSessionId;
  if (!id) return '';
  return (
    rawState.sessions.find((s) => s.id === id)?.title ??
    sessionListStore().doneSessions.find((s) => s.id === id)?.title ??
    ''
  );
});

const documentBaseTitle = useDocumentTitle({
  webTitle,
  activeWorkspaceRoot: () => visibleWorkspace.value?.root ?? null,
  activeWorkspaceName: () => visibleWorkspace.value?.name ?? null,
  activeSessionTitle: activeSessionTitleForTab,
  segments: browserTabTitle.segments,
});

const sessionsForView = computed<Session[]>(() => sessionViewsStore().sessionsForView);
const flatSessionsAll = computed<Session[]>(() => sessionViewsStore().flatSessionsAll);
const sidebarFlatSessionsAll = computed<Session[]>(() => sessionViewsStore().unpinnedFlatSessionsAll);
const workspaceGroups = computed<WorkspaceGroup[]>(() => sessionViewsStore().workspaceGroups);
const pendingBySession = computed<Record<string, { approvals: number; questions: number }>>(
  () => sessionViewsStore().pendingBySession,
);
const unreadBySession = computed<Record<string, boolean>>(
  () => sessionViewsStore().unreadBySession,
);

function recentSessionsForWorkspace(workspaceId: string | null, limit = 6): Session[] {
  return sessionViewsStore().recentSessionsForWorkspace(workspaceId, limit, rawState.doneSessions);
}

const flatVisibleCount = ref(FLAT_SESSIONS_PAGE_SIZE);

function flatRowHasStatus(s: Session): boolean {
  return (
    sessionDisplayStatus({
      busy: s.busy,
      unread: unreadBySession.value[s.id] ?? false,
      questionCount: pendingBySession.value[s.id]?.questions ?? 0,
      approvalCount: pendingBySession.value[s.id]?.approvals ?? 0,
      pendingInteraction: s.pendingInteraction,
      lastTurnReason: s.lastTurnReason,
    }) !== 'idle'
  );
}

const flatRenderCount = computed<number>(() => {
  const all = flatSessionsAll.value;
  let window = flatVisibleCount.value;
  for (let i = all.length - 1; i >= window; i--) {
    if (flatRowHasStatus(all[i]!)) {
      window = i + 1;
      break;
    }
  }
  return window;
});

const flatSessions = computed<Session[]>(() =>
  flatSessionsAll.value.slice(0, flatRenderCount.value),
);

const flatListHasMore = computed(
  () =>
    rawState.flatSessionsHasMore || flatRenderCount.value < flatSessionsAll.value.length,
);

function loadMoreFlatSessions(): void {
  flatVisibleCount.value = flatRenderCount.value + FLAT_SESSIONS_PAGE_SIZE;
  if (
    flatVisibleCount.value > flatSessionsAll.value.length &&
    rawState.flatSessionsHasMore
  ) {
    void sessionListStore().loadMoreFlatSessions();
  }
}

const sidebarFlatVisibleCount = ref(FLAT_SESSIONS_PAGE_SIZE);

const sidebarFlatRenderCount = computed<number>(() => {
  const all = sidebarFlatSessionsAll.value;
  let window = sidebarFlatVisibleCount.value;
  for (let i = all.length - 1; i >= window; i--) {
    if (flatRowHasStatus(all[i]!)) {
      window = i + 1;
      break;
    }
  }
  return window;
});

const sidebarFlatSessions = computed<Session[]>(() =>
  sidebarFlatSessionsAll.value.slice(0, sidebarFlatRenderCount.value),
);

const sidebarFlatHasMore = computed(
  () =>
    rawState.flatSessionsHasMore ||
    sidebarFlatRenderCount.value < sidebarFlatSessionsAll.value.length,
);

function ensureSidebarFlatSessions(): Promise<void> {
  return sessionListStore().ensureSidebarFlatSessions(sidebarFlatVisibleCount.value);
}

function loadMoreSidebarFlatSessions(): void {
  sidebarFlatVisibleCount.value = sidebarFlatRenderCount.value + FLAT_SESSIONS_PAGE_SIZE;
  if (
    sidebarFlatVisibleCount.value > sidebarFlatSessionsAll.value.length &&
    rawState.flatSessionsHasMore
  ) {
    void sessionListStore().loadMoreFlatSessions({
      excludePinnedWorkspaces: true,
      minUnpinnedCount: sidebarFlatVisibleCount.value,
    });
  }
}

const doneVisibleCount = ref(FLAT_SESSIONS_PAGE_SIZE);

const doneSessionsAll = computed<Session[]>(() => {
  void sessionViewsStore().sessionTimeClock;
  const { visibleWorkspaceIds, workspaceById } = workspacesStore();
  return rawState.doneSessions
    .filter((s) => visibleWorkspaceIds.has(workspaceIdForSession(s)))
    .map((s) => {
      const workspaceId = workspaceIdForSession(s);
      const ws = workspaceById.get(workspaceId);
      const live = rawState.sessions.find((p) => p.id === s.id);
      const updatedAt =
        live !== undefined && new Date(live.updatedAt).getTime() > new Date(s.updatedAt).getTime()
          ? live.updatedAt
          : s.updatedAt;
      return {
        id: s.id,
        title: s.title,
        time: formatTime(updatedAt),
        busy: live?.busy ?? s.busy,
        pendingInteraction: live?.pendingInteraction ?? s.pendingInteraction,
        lastTurnReason: live?.lastTurnReason ?? s.lastTurnReason,
        lastPrompt: s.lastPrompt,
        updatedAt,
        workspaceId,
        workspaceName: ws?.name,
        hostId: ws?.hostId,
        archived: true,
        cwdLabel: s.cwd ? basename(s.cwd) : '-',
        pullRequest: s.pullRequest,
        environment: sessionEnvironmentTag(s),
      };
    })
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
});

const doneSessions = computed<Session[]>(() =>
  doneSessionsAll.value.slice(0, doneVisibleCount.value),
);

const doneListHasMore = computed(
  () => rawState.doneSessionsHasMore || doneVisibleCount.value < doneSessionsAll.value.length,
);

function loadMoreDoneSessions(): void {
  doneVisibleCount.value += FLAT_SESSIONS_PAGE_SIZE;
  if (doneVisibleCount.value > doneSessionsAll.value.length && rawState.doneSessionsHasMore) {
    void sessionListStore().loadMoreDoneSessions();
  }
}

const activeSessionArchived = computed<boolean>(() => {
  const id = rawState.activeSessionId;
  if (!id) return false;
  return rawState.sessions.find((s) => s.id === id)?.archived === true;
});

const availableOpenInApps = computed<string[]>(() => rawState.availableOpenInApps);

const mainUndoTarget = (sessionId: string, turnId?: string): { turnId: string; text: string } | null => {
  const turns = mainTurnsOf(sessionId);
  const turn = turnId === undefined
    ? turns.findLast((candidate) => undoableOpener(candidate) !== undefined)
    : turns.find((candidate) => candidate.turn_id === turnId);
  const opener = turn === undefined ? undefined : undoableOpener(turn);
  return turn === undefined || opener === undefined ? null : { turnId: turn.turn_id, text: opener.text };
};

const sessionSelection = createSessionSelection({
  modelProvider,
  hasLoadedMessages,
  whenMainConversationLoaded,
  prefetchMainConversation: (sessionId) => {
    mainConversations.prefetch(sessionId, MAIN_AGENT_ID);
  },
  markSessionStatusSettled,
  appendSession,
  setActiveSessionId,
  writeSessionUrl: (sessionId, mode) => sessionRoute.writeSessionUrl(sessionId, mode),
  setMainView: (view) => {
    rawState.mainView = view;
  },
  setSessionLoading: (loading) => {
    rawState.sessionLoading = loading;
  },
});

const sessionRoute = createSessionRoute(rawState, {
  selectSession: sessionSelection.selectSession,
  fetchSessionIntoList: sessionSelection.fetchSessionIntoList,
  setActiveSessionId,
});

const promptPipeline = usePromptPipeline(rawState, {
  sideChat,
  modelProvider,
  activity,
  nextOptimisticMsgId,
  persistSessionProfile,
  whenSessionProfileSettled,
  mapSendAuthFailure,
  isMainTurnRunning: mainTurnRunning,
  hasUnechoedPrompt: (sessionId) => unechoedOptimisticMessages(sessionId).length > 0,
  isCompacting: isMainCompactingOrStarting,
  isMainWaitForWaiting: mainWaitForWaiting,
  promptIdToAbort: mainPromptIdToAbort,
  lastAgentTurnId: (sessionId) => mainTurnsOf(sessionId).findLast((turn) => turn.kind === 'agent')?.turn_id,
  selectSession: sessionSelection.selectSession,
  upsertSessionSorted,
});

watch(
  () =>
    rawState.sessions
      .filter((session) => sessionWorktreeHoldsPrompts(session) || sessionWorktreeBlocksSend(session))
      .map((session) => session.id)
      .join('\n'),
  (next, previous) => {
    const stillGated = new Set(next === '' ? [] : next.split('\n'));
    for (const id of previous === '' ? [] : previous.split('\n')) {
      if (stillGated.has(id)) continue;
      promptPipeline.syncWorktreeHold(id);
      reloadSessionDirectoryViews(id);
    }
  },
);

watch(
  () =>
    rawState.sessions.flatMap((session) => {
      const held = session.worktree?.heldPrompt;
      return held === undefined ? [] : [`${session.id} ${held.promptId} ${held.failure === undefined ? 'held' : 'failed'}`];
    }),
  (next, previous = []) => {
    const changed = new Set([...next, ...previous].filter((entry) => !next.includes(entry) || !previous.includes(entry)));
    for (const id of new Set([...changed].map((entry) => entry.split(' ')[0]!))) promptPipeline.syncWorktreeHold(id);
  },
  { immediate: true },
);

function reloadSessionDirectoryViews(id: string): void {
  if (!rawState.sessions.some((session) => session.id === id)) return;
  const readOptions = id === rawState.activeSessionId
    ? sessionReadScope.options(id)
    : sessionReadScope.offscreenOptions(id);
  filesStore().clearSessionFileTree(id);
  void filesStore().loadGitStatus(id, readOptions);
  void sessionInfoStore().refresh(id, readOptions);
}

watch(
  () => new Map(rawState.sessions.map((session) => [session.id, session.cwd])),
  (next, previous) => {
    for (const [id, cwd] of next) {
      const before = previous.get(id);
      if (before !== undefined && before !== cwd) reloadSessionDirectoryViews(id);
    }
  },
);

const activeSessionWorktree = computed<AppSession['worktree']>(
  () => rawState.sessions.find((session) => session.id === rawState.activeSessionId)?.worktree,
);

const activeSessionEnvironment = computed<SessionEnvironmentKind>(() =>
  classifySessionEnvironment({ worktree: activeSessionWorktree.value }),
);

const sessionActions = createSessionActions({
  mainUndoTarget,
  updateSession,
  selectSession: sessionSelection.selectSession,
  upsertSessionSorted,
  promptBacklog: promptPipeline.promptBacklog,
  isCompactionRunning: (sessionId) =>
    promptStore().isCompactFlushHeld(sessionId) || isMainCompactingOrStarting(sessionId),
  flushQueue: promptPipeline.flushQueueHead,
});

const workspaceBoot = createWorkspaceBoot(rawState, {
  connectEventsIfNeeded,
  modelProvider,
  bindSessionRoute: sessionRoute.bindSessionRoute,
  writeSessionUrl: sessionRoute.writeSessionUrl,
  unpinSessions,
  setActiveSessionId,
  sessionSelection,
  resumeObservationReads: () => {
    const sid = rawState.activeSessionId;
    if (sessionReadScope.activate(sid) && sid !== undefined) {
      sessionSelection.refreshSessionSidecars(sid, {
        skipStatus: rawState.sessionStatusSettledBySession[sid] === true,
      });
    }
    observeWorkspace(activeWorkspaceId.value);
  },
});

const { confirm } = useConfirmDialog();
configureWorkspaceHooks({
  persistSessionProfile,
  confirmGoalStart: (objective) =>
    confirm({
      title: t('workspace.goalStartTitle'),
      message: t('workspace.goalStartConfirm', { objective }),
      variant: 'primary',
    }),
  promptPipeline,
});
setFilesHooks({ pushOperationFailure: warningsStore().pushOperationFailure });
setConfigHooks({ pushOperationFailure: warningsStore().pushOperationFailure });
setApprovalsHooks({ pushOperationFailure: warningsStore().pushOperationFailure });
setTasksHooks({ pushOperationFailure: warningsStore().pushOperationFailure });
setAuthHooks({ reload: () => workspaceBoot.load() });
setHostsHooks({
  onHostsChanged: ({ removed, becameDisabled }) => {
    if (removed.length > 0) {
      const removedWorkspaces = workspacesStore().removeHostWorkspaces(removed);
      for (const workspaceId of removedWorkspaces) {
        refreshedSkillRootsByWorkspace.delete(workspaceId);
        modelProvider.invalidateSkillsForWorkspace(workspaceId);
      }
      const removedSessions = sessionListStore().removeHostSessions(removed, removedWorkspaces);
      for (const sessionId of removedSessions) {
        modelProvider.invalidateSkillsForSession(sessionId);
        forgetSession(sessionId);
      }
    }
    if (becameDisabled.length > 0) {
      workspacesStore().handleUnavailableHosts(becameDisabled);
    }
  },
});
setWorkspacesHooks({
  selectSession: (sid, opts) => sessionSelection.selectSession(sid, opts),
  writeSessionUrl: (sid, mode) => sessionRoute.writeSessionUrl(sid, mode),
  setMainView: (view) => {
    rawState.mainView = view;
  },
  setSessionLoading: (loading) => {
    rawState.sessionLoading = loading;
  },
  setActiveSessionId,
  refreshWorkspaceSkills: refreshSkillsForRoots,
});

setSessionListHooks({
  pushOperationFailure: warningsStore().pushOperationFailure,
  onSessionsArchivedLocally: async (ids) => {
    const idSet = new Set(ids);
    for (const id of ids) forgetSession(id);
    if (rawState.activeSessionId !== undefined && idSet.has(rawState.activeSessionId)) {
      const next = rawState.sessions[0];
      if (next) {
        await sessionSelection.selectSession(next.id, { urlMode: 'replace', skipTrack: true });
      } else {
        setActiveSessionId(undefined);
        sessionRoute.writeSessionUrl(undefined, 'replace');
      }
    }
  },
  onSessionDeletedLocally: async (id) => {
    persistComposerDraftSnapshot(id, '');
    forgetSession(id);
    sessionAdmin.dropSession(id);
    notifySessionDestroyed(id);
    notifySessionDeleted(id);
    const wasActive = rawState.activeSessionId === id;
    if (!wasActive) return;
    const next = rawState.sessions[0];
    if (next) {
      await sessionSelection.selectSession(next.id, { urlMode: 'replace', skipTrack: true });
    } else {
      setActiveSessionId(undefined);
      sessionRoute.writeSessionUrl(undefined, 'replace');
      rawState.sessionLoading = false;
    }
  },
  notify: warningsStore().pushWarning,
});

const sessionAdmin = useSessionAdmin({
  pushOperationFailure: warningsStore().pushOperationFailure,
  applySessionsArchivedLocally: sessionListStore().applySessionsArchivedLocally,
});
watch(
  () => rawState.mainView,
  (view) => {
    if (view === 'sessionAdmin') sessionAdmin.ensureSeeded();
  },
);

async function sendTowerPrompt(text: string, editText?: string): Promise<void> {
  const sid = rawState.activeSessionId;
  if (!sid) {
    const wsId = workspacesStore().activeWorkspaceId;
    if (!wsId) return;
    await promptPipeline.startSessionAndSendPrompt(wsId, promptPipeline.createPromptEnvelope({ text }));
    return;
  }
  const busy = activity.value !== 'idle' || promptStore().inFlightBySession[sid] === true;
  if (busy && (rawState.towerModeBySession?.[sid] ?? false)) {
    await promptPipeline.steerPrompt(promptPipeline.createPromptEnvelope({ text }));
    return;
  }
  await promptPipeline.sendPrompt(promptPipeline.createPromptEnvelope({ text }), editText);
}

type AppActionToastInput =
  | { kind: 'archive'; id: string; reopen?: boolean }
  | { kind: 'delete' }
  | { kind: 'export'; state: 'running' | 'done' }
  | { kind: 'adminBatch'; plan: AdminBatchToastPlan }
  | { kind: 'attachmentOpen'; name: string };

let latestActionToastKey = 0;

onToast((event) => {
  if (event.type === 'dismiss' && event.key === latestActionToastKey) {
    latestActionToastKey = 0;
  }
});

async function undoArchive(id: string, reopen: boolean, key: number): Promise<void> {
  if (reopen) {
    await sessionListStore().archiveSession(id);
    if (sessionsForView.value.some((s) => s.id === id)) return;
    notifySessionDestroyed(id);
    if (latestActionToastKey !== key) return;
    showActionToast({ kind: 'archive', id });
    return;
  }
  if (await sessionListStore().restoreSession(id)) {
    dismissToastByKey(key);
  }
}

async function undoAdminBatch(plan: AdminBatchToastPlan, key: number): Promise<void> {
  const direction = undoBatchDirectionOf(plan.direction);
  const outcome =
    direction === 'archive'
      ? await sessionAdmin.archiveSessions(plan.ids)
      : await sessionAdmin.restoreSessions(plan.ids);
  const nextPlan = planAdminBatchToast(direction, outcome);
  if (nextPlan === null || latestActionToastKey !== key) return;
  showActionToast({ kind: 'adminBatch', plan: nextPlan });
}

function archiveToastBody(id: string, reopen: boolean, key: number): Component {
  return () => {
    const undo = h(
      'button',
      { type: 'button', onClick: () => void undoArchive(id, reopen, key) },
      t('sidebar.archiveToastUndo'),
    );
    if (useSidebarTabs().sidebarTabs.value) {
      return [reopen ? t('sidebar.reopenToastLead') : t('sidebar.completeToastLead'), undo];
    }
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches) return [undo];
    return [
      undo,
      t('sidebar.archiveToastMid'),
      h(
        'button',
        { type: 'button', onClick: () => openArchivedSettings() },
        t('sidebar.archiveToastSettings'),
      ),
      t('sidebar.archiveToastTail'),
    ];
  };
}

function actionToastOptions(input: AppActionToastInput, key: number): ToastOptions {
  if (input.kind === 'archive') {
    return { layout: 'bar', mode: 'replace', body: archiveToastBody(input.id, input.reopen === true, key) };
  }
  if (input.kind === 'adminBatch') {
    const { plan } = input;
    return {
      layout: 'bar',
      mode: 'replace',
      title: `${t(plan.direction === 'archive' ? 'admin.batchDoneToast' : 'admin.batchReopenedToast', { n: plan.succeeded })}${plan.failed > 0 ? t('admin.batchFailedSuffix', { n: plan.failed }) : ''}`,
      actions: [{ label: t('admin.undo'), onClick: () => undoAdminBatch(plan, key) }],
    };
  }
  if (input.kind === 'delete') {
    return { layout: 'bar', mode: 'replace', title: t('sidebar.deleteToast') };
  }
  if (input.kind === 'attachmentOpen') {
    return { layout: 'bar', mode: 'replace', title: t('composer.attachmentOpenUnsupported', { name: input.name }), duration: 4000 };
  }
  return {
    layout: 'bar',
    mode: 'replace',
    title: input.state === 'running' ? t('commands.export.started') : t('commands.export.done'),
    running: input.state === 'running',
    variant: input.state === 'done' ? 'success' : 'info',
    duration: input.state === 'running' ? 60000 : 4000,
  };
}

function showActionToastWithKey(input: AppActionToastInput, key: number): void {
  latestActionToastKey = key;
  toast(actionToastOptions(input, key), key);
}

function showActionToast(input: AppActionToastInput): void {
  showActionToastWithKey(input, nextToastKey());
}

async function archiveSessionWithToast(id: string): Promise<void> {
  await sessionListStore().archiveSession(id);
  if (sessionsForView.value.some((s) => s.id === id)) return;
  notifySessionDestroyed(id);
  showActionToast({ kind: 'archive', id });
}

async function deleteWorktreeSessionWithToast(
  id: string,
  title: string,
  path: string,
  branch: string | undefined,
): Promise<boolean> {
  const outcome = await useWorktreeManageDialogs().requestSessionDeletion(
    { sessionId: id, title, path, ...(branch === undefined ? {} : { branch }) },
    ({ deleteBranch }) => sessionListStore().deleteSessionWithOptions(id, { removeWorktree: true, deleteBranch }),
  );
  if (!outcome.confirmed) return outcome.directoryMissing !== true;
  const result = outcome.value;
  if (result === null) return true;
  const worktrees = worktreesStore();
  if (result.worktree?.outcome === 'failed') {
    worktrees.recordSessionRemovalFailure({
      path,
      sessionTitle: title,
      branch,
      reason: 'in_use',
      output: result.worktree.output,
    });
    if (worktrees.loaded) void worktrees.load();
    toastWithManage(t('worktreeManage.toastSessionDirectoryKept'));
    return true;
  }
  if (worktrees.loaded) void worktrees.load();
  showActionToast({ kind: 'delete' });
  return true;
}

async function deleteSessionWithToast(
  id: string,
  opts?: { title?: string; worktree?: AppSessionWorktree },
): Promise<void> {
  const known =
    rawState.sessions.find((s) => s.id === id) ?? sessionListStore().doneSessions.find((s) => s.id === id);
  const title = opts?.title ?? known?.title ?? id;
  const worktree = opts?.worktree ?? known?.worktree;
  if (worktree?.path !== undefined && classifySessionEnvironment({ worktree }) === 'worktree') {
    if (await deleteWorktreeSessionWithToast(id, title, worktree.path, worktree.branch)) return;
  }
  let deleted = false;
  const confirmed = await confirm({
    title: t('sidebar.deleteConfirmTitle'),
    message: t('sidebar.deleteConfirmMessage', { title }),
    confirmLabel: t('sidebar.deleteConfirmButton'),
    cancelLabel: t('common.cancel'),
    variant: 'danger',
    action: async () => {
      deleted = await sessionListStore().deleteSession(id);
    },
  });
  if (!confirmed || !deleted) return;
  showActionToast({ kind: 'delete' });
}

async function restoreSessionWithToast(id: string): Promise<void> {
  if (await sessionListStore().restoreSession(id)) {
    showActionToast({ kind: 'archive', id, reopen: true });
  }
}

let exportToastInFlight = false;

async function exportSessionWithToast(id?: string): Promise<void> {
  if (exportToastInFlight) return;
  exportToastInFlight = true;
  const key = nextToastKey();
  let runningRevision = toastReplaceRevision();
  let runningShown = false;
  const slowTimer = setTimeout(() => {
    if (toastReplaceRevision() === runningRevision) {
      showActionToastWithKey({ kind: 'export', state: 'running' }, key);
      runningRevision = toastReplaceRevision();
      runningShown = true;
    }
  }, 400);
  try {
    const ok = await sessionActions.exportSession(id);
    if (ok && !isDesktop) {
      if (toastReplaceRevision() === runningRevision && (!runningShown || latestActionToastKey === key)) {
        showActionToast({ kind: 'export', state: 'done' });
      }
    } else if (runningShown && latestActionToastKey === key && toastReplaceRevision() === runningRevision) {
      dismissToastByKey(key);
    }
  } finally {
    clearTimeout(slowTimer);
    exportToastInFlight = false;
  }
}

function isUserWatching(sid: string): boolean {
  return (
    sid === rawState.activeSessionId &&
    typeof document !== 'undefined' &&
    document.visibilityState === 'visible' &&
    document.hasFocus()
  );
}

function isWindowHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState !== 'visible';
}

function onMainTurnEnd(
  sid: string,
  status: 'idle' | 'aborted',
  opts: {
    firstTurn: boolean;
    promptId?: string;
    ratingTurnId?: string;
    predictionSourceId?: string;
    predictionTurnId?: number;
    continuation?: ConversationContinuation;
  },
): void {
  const goalActive = rawState.goalBySession[sid]?.status === 'active';

  if (opts.firstTurn) {
    sessionListStore().maybeGenerateSessionTitle(sid);
  }
  if (opts.ratingTurnId !== undefined) {
    sessionRatingStore().noteMainTurnEnded(sid, opts.ratingTurnId, () => isUserWatching(sid));
  }

  const readOptions = sid === rawState.activeSessionId
    ? sessionReadScope.options(sid)
    : sessionReadScope.offscreenOptions(sid);
  void filesStore().loadGitStatus(sid, readOptions);
  void sessionInfoStore().refresh(sid, readOptions);
  warningsStore().refreshSessionWarnings(sid, readOptions);
  void modelsStore().loadSkillsForSession(sid, readOptions);
  if (sid === rawState.activeSessionId) {
    const diffRoot = filesStore().selectedDiffRoot;
    if (diffRoot !== undefined) void filesStore().loadGitStatus(sid, { ...readOptions, root: diffRoot });
    if (status === 'idle' && !goalActive && isWindowHidden()) {
      sessionViewsStore().markUnread(sid);
    }
  } else if (status === 'idle' && !goalActive) {
    sessionViewsStore().markUnread(sid);
  }

  const hasPendingApproval = (rawState.approvalsBySession[sid] ?? []).length > 0;
  const hasPendingQuestion = (rawState.questionsBySession[sid] ?? []).length > 0;
  if (!goalActive && shouldNotifyCompletion(status, hasPendingApproval, hasPendingQuestion, opts.continuation)) {
    notificationsStore().maybeNotifyCompletion(sid, {
      isUserWatching: isUserWatching(sid),
      sessionTitle: rawState.sessions.find((s) => s.id === sid)?.title ?? '',
      promptId: opts.promptId,
      onClick: () => {
        void sessionSelection.selectSession(sid, { source: 'notification' });
      },
    });
  }

  if (opts.predictionSourceId !== undefined && opts.predictionTurnId !== undefined && Number.isSafeInteger(opts.predictionTurnId)) {
    promptPredictionController.handleTurnEnded(sid, opts.predictionSourceId, opts.predictionTurnId, status === 'idle');
  }
}

function onQuestionRequested(sid: string, question: AppQuestionRequest): void {
  const first = question.questions[0];
  const header = first?.header?.trim() ?? '';
  const questionText = first?.question?.trim() ?? '';
  const preview =
    header && questionText ? `${header}: ${questionText}` : questionText || header;

  notificationsStore().maybeNotifyQuestion({
    isUserWatching: isUserWatching(sid),
    sessionTitle: rawState.sessions.find((s) => s.id === sid)?.title ?? '',
    questionPreview: preview,
    questionId: question.questionId,
    onClick: () => {
      void sessionSelection.selectSession(sid, { source: 'notification' });
    },
  });
}

function onApprovalRequested(sid: string, approval: AppApprovalRequest): void {
  notificationsStore().maybeNotifyApproval({
    isUserWatching: isUserWatching(sid),
    sessionTitle: rawState.sessions.find((s) => s.id === sid)?.title ?? '',
    toolName: approval.toolName,
    approvalId: approval.approvalId,
    onClick: () => {
      void sessionSelection.selectSession(sid, { source: 'notification' });
    },
  });
}

export function useKimiWebClient() {
  sessionViewsStore().ensureSessionTimeClock();

  return {
    workspace,
    sessions,
    activeSessionId,

    workspacesView,
    workspaceSortMode,
    visibleWorkspace,
    activeWorkspaceId,
    sessionMentionCandidates,
    searchSessionMentions,
    activeWorkspaceTrust,
    activeWorkspaceTrustError,
    activeWorkspaceTrustLoading,
    sessionsForView,
    workspaceGroups,
    flatSessions,
    flatSessionsHasMore: flatListHasMore,
    flatSessionsLoadingMore: computed(() => rawState.flatSessionsLoadingMore),
    sidebarFlatSessions,
    sidebarFlatSessionsHasMore: sidebarFlatHasMore,
    doneSessions,
    doneSessionsHasMore: doneListHasMore,
    doneSessionsLoadingMore: computed(() => rawState.doneSessionsLoadingMore),
    activeSessionArchived,
    recentSessionsForWorkspace,
    draftEntry: computed(() => promptStore().draftEntry),
    draftEntryNonce: computed(() => promptStore().draftEntryNonce),
    mainView: computed(() => rawState.mainView),
    pendingBySession,
    unreadBySession,

    turns,
    tasks,
    activeAppTasks,
    findBashCommandForTask,
    findSubagentPromptForTask,
    auxiliaryConversations,
    getFileUrl: getFileUrlById,
    getSessionMediaUrl,
    todos,
    goal,
    sessionPlans,
    swarms,
    swarmMembersByToolCallId,
    activationBadges,
    compaction,
    status,
    unavailableModelBySession: computed(() => rawState.unavailableModelBySession),
    sessionCost,
    fileDiff,
    selectedDiffPath: computed(() => filesStore().selectedDiffPath),
    selectedDiffRoot: computed(() => filesStore().selectedDiffRoot),
    fileDiffLoading: computed(() => filesStore().fileDiffLoading),
    fileDiffLoadedSeq: computed(() => filesStore().fileDiffLoadedSeq),
    fileDiffLoadStartedSeq: computed(() => filesStore().fileDiffLoadStartedSeq),
    fileDiffRefreshing: computed(() => filesStore().fileDiffRefreshing),
    fileDiffTexts: computed(() => filesStore().fileDiffTexts),
    fileDiffEmptyFile: computed(() => filesStore().fileDiffEmptyFile),
    changes,
    gitInfo,
    gitDiffStats,
    activePullRequest,
    changesByPath,
    pendingApprovals,
    availableOpenInApps,

    retainSessionExecution(sessionId: string): (() => void) & { ready: Promise<void> } {
      const entry = mainConversations.activate(sessionId, MAIN_AGENT_ID);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        mainConversations.deactivate(sessionId, MAIN_AGENT_ID);
      };
      return Object.assign(release, { ready: mainConversations.whenLoaded(entry) });
    },
    getSessionExecutionState(sessionId: string): SessionExecutionState {
      return sessionExecutionState(sessionId);
    },
    awaitSessionExecutionState(sessionId: string, timeoutMs: number): Promise<SessionExecutionState> {
      return waitForSessionExecution({
        read: () => sessionExecutionState(sessionId),
        turnActive: () => sessionViewsStore().isMainTurnActive(sessionId),
        timeoutMs,
      });
    },
    connection,
    loading,
    sessionLoading,
    loadingMoreMessages,
    hasMoreMessages,
    loadMoreMessagesError,
    serverVersion,
    webTitle,
    documentBaseTitle,
    backend,
    dangerousBypassAuth,
    experimentalFlags,
    clearDangerousBypassAuth,
    initialized: workspaceBoot.initialized,
    connectIssue,
    bootStage: workspaceBoot.bootStage,
    bootRetries: workspaceBoot.bootRetries,
    permission,
    thinking,
    planMode,
    planArmed,
    swarmMode,
    towerMode,
    goalMode,
    queued,
    promptPrediction: computed(() => {
      const current = promptPredictionController.suggestion.value;
      return current !== null && canUsePromptPrediction(current.sessionId) ? current : null;
    }),
    promptPredictionHasTurn: computed(() => {
      const target = promptPredictionController.predictionTarget.value;
      if (target === undefined || target.sessionId !== rawState.activeSessionId) return false;
      if (promptPredictionController.active.value !== undefined || promptPredictionController.suggestion.value !== null) return true;
      return promptPredictionController.canAttemptPrediction();
    }),
    promptPredictionPending: computed(() => {
      const current = promptPredictionController.active.value;
      return current !== undefined && canUsePromptPrediction(current.sessionId) && hasEmptyPromptPredictionInput(current.sessionId)
        ? { sessionId: current.sessionId, parked: current.parked }
        : null;
    }),
    acceptPromptPrediction: (key: 'tab' | 'right') => promptPredictionController.accept(key),
    handlePromptPredictionInput: () => promptPredictionController.handleInput(),
    handlePromptPredictionSubmit: (text: string) => promptPredictionController.handleSubmit(text),
    warnings,
    questions,
    activity,
    turnActive,
    activeTurnError,
    activeTurnRetry,
    activeTurnEnd,
    inFlight,
    working,
    isStartingFirstPrompt,

    models: modelProvider.models,
    recentModelIds: modelProvider.recentModelIds,
    providers: modelProvider.providers,

    fontScale: appearance.fontScale,
    setFontScale: appearance.setFontScale,

    colorScheme: appearance.colorScheme,
    setColorScheme: appearance.setColorScheme,

    onboarded,
    setOnboarded,

    load: workspaceBoot.load,
    selectSession: sessionSelection.selectSession,
    openSessionLink: sessionSelection.openSessionLink,
    clearActiveSession: workspacesStore().clearActiveSession,
    openSessionAdmin: (workspaceId?: string) => {
      if (workspaceId !== undefined) {
        sessionAdmin.applyFilters({
          workspaceIds: [workspaceId],
          status: 'all',
          updatedFrom: '',
          updatedTo: '',
        });
      }
      sessionRoute.openSessionAdmin();
    },
    closeSessionAdmin: sessionRoute.closeSessionAdmin,

    sessionAdminItems: computed(() => sessionAdmin.state.items),
    sessionAdminTotal: computed(() => sessionAdmin.state.total),
    sessionAdminLoading: computed(() => sessionAdmin.state.loading),
    sessionAdminFilters: computed(() => sessionAdmin.state.filters),
    sessionAdminPage: computed(() => sessionAdmin.state.page),
    sessionAdminPageSize: computed(() => sessionAdmin.state.pageSize),
    refreshSessionAdminSessions: sessionAdmin.refresh,
    applySessionAdminFilters: sessionAdmin.applyFilters,
    setSessionAdminWorkspaceFilter: sessionAdmin.setWorkspaceIds,
    setSessionAdminStatusFilter: sessionAdmin.setStatus,
    setSessionAdminTimeRange: sessionAdmin.setTimeRange,
    setSessionAdminPage: sessionAdmin.setPage,
    setSessionAdminPageSize: sessionAdmin.setPageSize,

    sessionAdminSelectedIds: computed(() => sessionAdmin.state.selectedIds),
    sessionAdminSelectedCount: computed(() => sessionAdmin.state.selectedIds.size),
    sessionAdminOpenSelectedIds: computed(() => sessionAdmin.selectedIdsByArchived(false)),
    sessionAdminDoneSelectedIds: computed(() => sessionAdmin.selectedIdsByArchived(true)),
    toggleSessionAdminSelection: sessionAdmin.toggleSelection,
    toggleSessionAdminPageSelection: sessionAdmin.togglePageSelection,
    setSessionAdminSelection: sessionAdmin.setSelection,
    clearSessionAdminSelection: sessionAdmin.clearSelection,
    selectSessionAdminAllMatching: sessionAdmin.selectAllMatching,
    sessionAdminAllMatching: computed(() => sessionAdmin.state.allMatching),
    sessionAdminMaterializingAll: computed(() => sessionAdmin.state.materializingAll),
    archiveSessions: sessionAdmin.archiveSessions,
    restoreSessions: sessionAdmin.restoreSessions,
    loadOlderMessages: async (sessionId: string): Promise<void> => {
      const entry = mainConversationOf(sessionId);
      if (entry !== undefined) await mainConversations.loadOlder(entry);
    },

    loadWorkspaces: () => workspacesStore().loadWorkspaces(),
    loadMoreSessions: sessionListStore().loadMoreSessions,
    loadAllSessions: sessionListStore().loadAllSessions,
    ensureFlatSessions: sessionListStore().ensureFlatSessions,
    ensureSidebarFlatSessions,
    loadMoreFlatSessions,
    loadMoreSidebarFlatSessions,
    ensureDoneSessions: sessionListStore().ensureDoneSessions,
    loadMoreDoneSessions,
    selectWorkspace: (id: string) => workspacesStore().selectWorkspace(id),
    ensureWorkspaceTrust,
    trustWorkspace: async (id: string) => {
      const result = await workspacesStore().trustWorkspace(id);
      if (result.status === 'success' && result.trusted) {
        void modelProvider.loadSkillsForWorkspace(id);
        const sid = rawState.activeSessionId;
        const session = rawState.sessions.find((candidate) => candidate.id === sid);
        if (
          sid !== undefined &&
          session !== undefined &&
          workspacesStore().sessionBelongsToWorkspace(session, id) &&
          !Object.prototype.hasOwnProperty.call(modelProvider.skillsBySession.value, sid)
        ) {
          void modelProvider.loadSkillsForSession(sid, sessionReadScope.options(sid));
        }
      }
      return result;
    },
    openWorkspace: workspacesStore().openWorkspace,
    openWorkspaceDraft: workspacesStore().openWorkspaceDraft,
    createPromptEnvelope: promptPipeline.createPromptEnvelope,
    startSessionAndSendPrompt: promptPipeline.startSessionAndSendPrompt,
    startSessionAndActivateSkill: promptPipeline.startSessionAndActivateSkill,
    startSessionAndOpenSideChat: promptPipeline.startSessionAndOpenSideChat,
    getDraftPromotion,
    addWorkspaceByPath: workspacesStore().addWorkspaceByPath,
    browseFs: workspacesStore().browseFs,
    getFsHome: workspacesStore().getFsHome,
    mkdirFs: workspacesStore().mkdirFs,

    sendPrompt: promptPipeline.sendPrompt,
    wouldEnqueuePrompt: promptPipeline.wouldEnqueuePrompt,
    wouldSteerPrompt: promptPipeline.wouldSteerPrompt,
    steerPrompt: promptPipeline.steerPrompt,
    steerPromptDirect: promptPipeline.steerPromptDirect,
    steerQueued: promptPipeline.steerQueued,
    sideChatVisible: sideChat.sideChatVisible,
    sideChatSessionId: sideChat.sideChatSessionId,
    sideChatTurns: sideChat.sideChatTurns,
    sideChatRunning: sideChat.sideChatRunning,
    sideChatSending: sideChat.sideChatSending,
    openSideChat: sideChat.openSideChat,
    closeSideChat: sideChat.closeSideChat,
    sendSideChatPrompt: sideChat.sendSideChatPrompt,
    sideChatTargetsOfSession: sideChat.sideChatTargetsOfSession,
    restoreSideChatTarget: sideChat.restoreSideChatTarget,
    sideChatTurnsOf: sideChat.sideChatTurnsOf,
    sideChatRunningOf: sideChat.sideChatRunningOf,
    sideChatSendingOf: sideChat.sideChatSendingOf,
    sideChatTurnErrorOf: sideChat.sideChatTurnErrorOf,
    openSideChatOn: sideChat.openSideChatOn,
    sendSideChatPromptOn: sideChat.sendSideChatPromptOn,
    cancelSideChat: sideChat.cancelSideChat,
    cancelSideChatOn: sideChat.cancelSideChatOn,
    saveSideChatDraft: sideChat.saveSideChatDraft,
    sideChatDraft: sideChat.sideChatDraft,
    clearSideChatDraftIfUnchanged: sideChat.clearSideChatDraftIfUnchanged,
    uploadImage: promptPipeline.uploadImage,
    abortCurrentPrompt: promptPipeline.abortCurrentPrompt,
    activeSessionWorktree,
    activeSessionEnvironment,
    runSessionWorktreeAction: promptPipeline.runSessionWorktreeAction,
    retrySessionWorktree: (sessionId: string, input?: SessionWorktreeRetryInput) =>
      promptPipeline.runSessionWorktreeAction(sessionId, 'retry', input),
    cancelSessionWorktree: (sessionId: string) => promptPipeline.runSessionWorktreeAction(sessionId, 'cancel'),
    useLocalForSessionWorktree: (sessionId: string) => promptPipeline.runSessionWorktreeAction(sessionId, 'useLocal'),
    recreateSessionWorktree: (sessionId: string) => promptPipeline.runSessionWorktreeAction(sessionId, 'recreate'),
    deleteSession: sessionListStore().deleteSessionWithOptions,
    continueSession: promptPipeline.continueSession,
    respondApproval: approvalsStore().respondApproval,
    respondQuestion: approvalsStore().respondQuestion,
    dismissQuestion: approvalsStore().dismissQuestion,
    pendingQuestionActions: approvalsStore().pendingQuestionActions,
    pendingApprovalActions: approvalsStore().pendingApprovalActions,
    cancelTask: tasksStore().cancelTask,
    pendingTaskCancellations: tasksStore().pendingTaskCancellations,
    detachTask: tasksStore().detachTask,
    agentRunningOf: (sessionId: string, agentId: string) => agentStatesStore().running(sessionId, agentId),
    watchTaskOutput: taskOutputStream.watch,
    unwatchTaskOutput: taskOutputStream.unwatch,
    taskOutputOf: taskOutputStream.outputOf,

    setPermission: permissionsStore().setPermission,
    setThinking,
    ...workspaceModeActions(sendTowerPrompt),
    enqueue: promptPipeline.enqueue,
    renameSession: sessionListStore().renameSession,
    regenerateSessionTitle: sessionListStore().regenerateSessionTitle,
    renameWorkspace: workspacesStore().renameWorkspace,
    deleteWorkspace: workspacesStore().deleteWorkspace,
    reorderWorkspaces,
    setWorkspaceSortMode,
    pinWorkspace,
    togglePinWorkspace,
    reorderPinned,
    pinSession,
    unpinSession,
    togglePinSession,
    archiveSession: sessionListStore().archiveSession,
    exportSession: sessionActions.exportSession,
    restoreSession: sessionListStore().restoreSession,
    showActionToast,
    archiveSessionWithToast,
    deleteSessionWithToast,
    restoreSessionWithToast,
    exportSessionWithToast,
    loadArchivedSessions: sessionListStore().loadArchivedSessions,
    isSessionDeleted: sessionListStore().hasDeletedTombstone,
    compact: sessionActions.compact,
    forkSession: sessionActions.forkSession,
    undo: sessionActions.undo,
    reloadSession: sessionActions.reloadSession,

    unqueue: promptPipeline.unqueue,
    reorderQueue: promptPipeline.reorderQueue,
    searchFiles: filesStore().searchFiles,
    loadGitStatus: filesStore().loadGitStatus,
    loadFileDiff: filesStore().loadFileDiff,
    clearFileDiff: filesStore().clearFileDiff,

    readFileContent: filesStore().readFileContent,
    readHostFileContent: filesStore().readHostFileContent,
    readWorkspaceFileBlob: filesStore().readWorkspaceFileBlob,
    probeWorkspacePath: filesStore().probeWorkspacePath,
    getFileDownloadUrl: filesStore().getFileDownloadUrl,
    openWorkspaceFile: filesStore().openWorkspaceFile,
    revealWorkspaceFile: filesStore().revealWorkspaceFile,
    resolveImageUrl: filesStore().resolveImageUrl,

    loadModels: modelProvider.loadModels,
    loadProviders: modelProvider.loadProviders,
    skills,
    skillsLoaded,
    activateSkill: promptPipeline.activateSkill,
    selectModel,
    setSessionModel: (sessionId: string, modelId: string, thinking?: ThinkingLevel) => {
      beginModelSelect(sessionId);
      return modelProvider.setSessionModel(sessionId, modelId, thinking);
    },
    addProvider: modelProvider.addProvider,
    updateProvider: modelProvider.updateProvider,
    getProvider: modelProvider.getProvider,
    deleteProvider: modelProvider.deleteProvider,
    refreshProvider: modelProvider.refreshProvider,
    refreshAllProviders: modelProvider.refreshAllProviders,
    refreshOAuthProviderModels: modelProvider.refreshOAuthProviderModels,
    loadCatalogProviders: modelProvider.loadCatalogProviders,
    importCatalogProvider: modelProvider.importCatalogProvider,
    importCustomRegistry: modelProvider.importCustomRegistry,

    modelsReady,
    presetCatalogProviders,
    presetCatalogState,
    loadPresetCatalog: modelsStore().loadCatalogProviders,
    managedProviderStatus,
    managedUserInfo,
    managedMembership,
    chatGateVerdict,
    ensureChatReady,
    sendFailureVerdict,
    dismissSendFailureVerdict,

    notify: warningsStore().pushWarning,

    config,
    loadConfig: configStore().loadConfig,
    updateConfig: configStore().updateConfig,
    loadServerHome: async () => (await getKimiWebApi().getMeta()).homeDir,
    readHostTextFile: (path: string) => getKimiWebApi().readHostTextFile(path),
    writeHostTextFile: (path: string, content: string, revision: string | null) => getKimiWebApi().writeHostTextFile(path, content, revision),

    checkAuth: () => authStore().checkAuth(),
    probeManagedMembership: () => authStore().probeMembership(),
    startOAuthLogin: modelProvider.startOAuthLogin,
    pollOAuthLogin: modelProvider.pollOAuthLogin,
    cancelOAuthLogin: modelProvider.cancelOAuthLogin,
    getOAuthRegion: modelProvider.getOAuthRegion,
    getUsage: modelProvider.getUsage,
    logout: authStore().logout,
  };
}

export type { ApprovalDecision, AppModel, AppProvider };
