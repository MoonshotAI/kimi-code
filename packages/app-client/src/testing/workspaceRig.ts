import type { ComputedRef } from 'vue';
import type { AppSession } from '@moonshot-ai/app-core/api';
import type { ActivityState } from '@moonshot-ai/app-core/client/types';
import { t } from '../client/deps';
import { getDraftPromotion } from '../client/draftPromotion';
import { createWorkspaceBoot } from '../client/boot';
import { createSessionRoute } from '../client/sessionRoute';
import { createSessionSelection } from '../client/sessionSelection';
import { createSessionActions } from '../client/sessionActions';
import { usePromptPipeline } from '../client/usePromptPipeline';
import type { ExtendedState } from '../client/types';
import type { ChatGateVerdict } from '../lib/chatGate';
import { configureWorkspaceHooks } from '../lib/workspaceHooks';
import { workspaceModeActions } from '../lib/workspaceModeActions';
import type {
  PersistSessionProfilePatch,
  UseModelProviderState,
} from '../client/useModelProviderState';
import type { UseSideChat } from '../client/useSideChat';
import { useConfirmDialog } from '../composables/useConfirmDialog';
import { authStore } from '../stores/auth';
import { modeStore } from '../stores/mode';
import { permissionsStore } from '../stores/permissions';
import { promptStore } from '../stores/prompt';
import { sessionListStore } from '../stores/sessionList';
import { sessionsStore } from '../stores/sessions';
import { warningsStore } from '../stores/warnings';
import { workspacesStore } from '../stores/workspaces';

export interface WorkspaceRigDeps {
  sideChat: UseSideChat;
  modelProvider: UseModelProviderState;
  activity: ComputedRef<ActivityState>;
  updateSession: (id: string, update: (session: AppSession) => AppSession) => void;
  upsertSessionSorted: (session: AppSession) => void;
  appendSession: (session: AppSession) => void;
  unpinSessions: (ids: string[]) => void;
  setActiveSessionId: (id: string | undefined) => void;
  nextOptimisticMsgId: () => string;
  mainUndoTarget: (sessionId: string, turnId?: string) => { turnId: string; text: string } | null;
  isMainTurnRunning?: (sessionId: string) => boolean;
  hasUnechoedPrompt?: (sessionId: string) => boolean;
  isCompacting?: (sessionId: string) => boolean;
  isMainWaitForWaiting?: (sessionId: string) => boolean;
  promptIdToAbort?: (sessionId: string) => string | undefined;
  connectEventsIfNeeded?: () => void;
  hasLoadedMessages: (sessionId: string) => boolean;
  whenMainConversationLoaded?: (sessionId: string) => Promise<void>;
  markSessionStatusSettled: (sessionId: string) => void;
  persistSessionProfile: (
    patch: PersistSessionProfilePatch,
    sessionId?: string,
    preserveDraftThinking?: boolean,
  ) => Promise<boolean>;
  whenSessionProfileSettled: (sid: string) => Promise<boolean>;
  mapSendAuthFailure?: (err: unknown, sid?: string) => Promise<ChatGateVerdict | null>;
}

export function createWorkspaceRig(rawState: ExtendedState, deps: WorkspaceRigDeps) {
  const sessionSelection = createSessionSelection({
    modelProvider: deps.modelProvider,
    hasLoadedMessages: deps.hasLoadedMessages,
    whenMainConversationLoaded: deps.whenMainConversationLoaded,
    markSessionStatusSettled: deps.markSessionStatusSettled,
    appendSession: deps.appendSession,
    setActiveSessionId: deps.setActiveSessionId,
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
    setActiveSessionId: deps.setActiveSessionId,
  });
  const promptPipeline = usePromptPipeline(rawState, {
    sideChat: deps.sideChat,
    modelProvider: deps.modelProvider,
    activity: deps.activity,
    nextOptimisticMsgId: deps.nextOptimisticMsgId,
    persistSessionProfile: deps.persistSessionProfile,
    whenSessionProfileSettled: deps.whenSessionProfileSettled,
    mapSendAuthFailure: deps.mapSendAuthFailure,
    isMainTurnRunning: deps.isMainTurnRunning,
    hasUnechoedPrompt: deps.hasUnechoedPrompt,
    isCompacting: deps.isCompacting,
    isMainWaitForWaiting: deps.isMainWaitForWaiting,
    promptIdToAbort: deps.promptIdToAbort,
    selectSession: sessionSelection.selectSession,
    upsertSessionSorted: deps.upsertSessionSorted,
  });
  const sessionActions = createSessionActions({
    mainUndoTarget: deps.mainUndoTarget,
    updateSession: deps.updateSession,
    selectSession: sessionSelection.selectSession,
    upsertSessionSorted: deps.upsertSessionSorted,
    promptBacklog: promptPipeline.promptBacklog,
    isCompactionRunning: (sessionId) =>
      promptStore().isCompactFlushHeld(sessionId) || deps.isCompacting?.(sessionId) === true,
    flushQueue: promptPipeline.flushQueueHead,
  });
  const workspaceBoot = createWorkspaceBoot(rawState, {
    connectEventsIfNeeded: deps.connectEventsIfNeeded,
    modelProvider: deps.modelProvider,
    bindSessionRoute: sessionRoute.bindSessionRoute,
    writeSessionUrl: sessionRoute.writeSessionUrl,
    unpinSessions: deps.unpinSessions,
    setActiveSessionId: deps.setActiveSessionId,
    sessionSelection,
  });
  const { confirm } = useConfirmDialog();
  configureWorkspaceHooks({
    persistSessionProfile: deps.persistSessionProfile,
    confirmGoalStart: (objective) =>
      confirm({
        title: t('workspace.goalStartTitle'),
        message: t('workspace.goalStartConfirm', { objective }),
        variant: 'primary',
      }),
    promptPipeline,
  });

  async function sendTowerPrompt(text: string, editText?: string): Promise<void> {
    const sid = sessionsStore().activeSessionId;
    if (!sid) {
      const wsId = workspacesStore().activeWorkspaceId;
      if (!wsId) return;
      await promptPipeline.startSessionAndSendPrompt(wsId, promptPipeline.createPromptEnvelope({ text }));
      return;
    }
    const busy = deps.activity.value !== 'idle' || promptStore().inFlightBySession[sid] === true;
    if (busy && (modeStore().towerModeBySession?.[sid] ?? false)) {
      await promptPipeline.steerPrompt(promptPipeline.createPromptEnvelope({ text }));
      return;
    }
    await promptPipeline.sendPrompt(promptPipeline.createPromptEnvelope({ text }), editText);
  }

  return {
    initialized: workspaceBoot.initialized,
    bootStage: workspaceBoot.bootStage,
    bootRetries: workspaceBoot.bootRetries,
    listAllSessionsGlobal: sessionListStore().listAllSessionsGlobal,
    load: workspaceBoot.load,
    loadMoreSessions: sessionListStore().loadMoreSessions,
    loadAllSessions: sessionListStore().loadAllSessions,
    ensureFlatSessions: sessionListStore().ensureFlatSessions,
    loadMoreFlatSessions: sessionListStore().loadMoreFlatSessions,
    ensureDoneSessions: sessionListStore().ensureDoneSessions,
    loadMoreDoneSessions: sessionListStore().loadMoreDoneSessions,
    createPromptEnvelope: promptPipeline.createPromptEnvelope,
    startSessionAndSendPrompt: promptPipeline.startSessionAndSendPrompt,
    startSessionAndActivateSkill: promptPipeline.startSessionAndActivateSkill,
    startSessionAndOpenSideChat: promptPipeline.startSessionAndOpenSideChat,
    getDraftPromotion,
    writeSessionUrl: sessionRoute.writeSessionUrl,
    openSessionAdmin: sessionRoute.openSessionAdmin,
    closeSessionAdmin: sessionRoute.closeSessionAdmin,
    fetchSessionIntoList: sessionSelection.fetchSessionIntoList,
    onSessionRoutePopState: sessionRoute.onSessionRoutePopState,
    bindSessionRoute: sessionRoute.bindSessionRoute,
    selectSession: sessionSelection.selectSession,
    submitPromptInternal: promptPipeline.submitPromptInternal,
    maybeGenerateSessionTitle: sessionListStore().maybeGenerateSessionTitle,
    sendPrompt: promptPipeline.sendPrompt,
    wouldEnqueuePrompt: promptPipeline.wouldEnqueuePrompt,
    wouldSteerPrompt: promptPipeline.wouldSteerPrompt,
    steerPrompt: promptPipeline.steerPrompt,
    steerPromptDirect: promptPipeline.steerPromptDirect,
    steerQueued: promptPipeline.steerQueued,
    resumeQueueIfIdle: promptPipeline.resumeQueueIfIdle,
    uploadImage: promptPipeline.uploadImage,
    enqueue: promptPipeline.enqueue,
    unqueue: promptPipeline.unqueue,
    reorderQueue: promptPipeline.reorderQueue,
    abortCurrentPrompt: promptPipeline.abortCurrentPrompt,
    refreshSessionWarnings: warningsStore().refreshSessionWarnings,
    markSessionWarningShown: warningsStore().markSessionWarningShown,
    ...workspaceModeActions(sendTowerPrompt),
    setPermission: permissionsStore().setPermission,
    dismissWarning: warningsStore().dismissWarning,
    renameSession: sessionListStore().renameSession,
    regenerateSessionTitle: sessionListStore().regenerateSessionTitle,
    archiveSession: sessionListStore().archiveSession,
    applySessionsArchivedLocally: sessionListStore().applySessionsArchivedLocally,
    applyRemoteSessionArchived: sessionListStore().applyRemoteSessionArchived,
    applyRemoteSessionRestored: sessionListStore().applyRemoteSessionRestored,
    notePoolInsert: sessionListStore().notePoolInsert,
    noteSessionDeleted: sessionListStore().noteSessionDeleted,
    exportSession: sessionActions.exportSession,
    restoreSession: sessionListStore().restoreSession,
    loadArchivedSessions: sessionListStore().loadArchivedSessions,
    logout: authStore().logout,
    compact: sessionActions.compact,
    forkSession: sessionActions.forkSession,
    undo: sessionActions.undo,
    refreshSessionSidecars: sessionSelection.refreshSessionSidecars,
  };
}

export type WorkspaceRig = ReturnType<typeof createWorkspaceRig>;
