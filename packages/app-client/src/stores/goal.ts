import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { AppGoal } from '@moonshot-ai/app-core/api';
import { GOAL_OBJECTIVE_MAX_LENGTH, isDaemonApiError } from '@moonshot-ai/app-core/api';
import { applyRecordDiff } from '@moonshot-ai/app-core/client';
import { getKimiWebApi, t } from '../client/deps';
import type { PromptEnvelope, PromptEnvelopeContent } from '../client/types';
import { composerDisplayText } from '../lib/browserReferenceSubmission';
import { clientPinia } from './pinia';
import { modeStore } from './mode';
import { permissionsStore } from './permissions';
import { sessionsStore } from './sessions';
import { workspacesStore } from './workspaces';

const GOAL_ERROR_KEYS: Record<number, string> = {
  40913: 'warnings.goal.alreadyExists',
  40914: 'warnings.goal.notFound',
  40915: 'warnings.goal.statusInvalid',
  40916: 'warnings.goal.notResumable',
  40917: 'warnings.goal.objectiveEmpty',
  40918: 'warnings.goal.objectiveTooLong',
};

const GOAL_EDIT_ERROR_KEYS: Record<number, string> = {
  ...GOAL_ERROR_KEYS,
  40915: 'warnings.goal.editComplete',
};

export function goalErrorMessage(err: unknown, keys: Record<number, string> = GOAL_ERROR_KEYS): string | undefined {
  if (!isDaemonApiError(err) || err.code === undefined) return undefined;
  const key = keys[err.code];
  return key ? t(key) : undefined;
}

export interface GoalHooks {
  pushOperationFailure: (
    operation: string,
    err: unknown,
    opts?: { title?: string; message?: string; sessionId?: string },
  ) => void;
  confirmGoalStart?: (objective: string) => Promise<boolean>;
  createDraftSession: (workspaceId: string) => Promise<string | null>;
  sendPrompt: (
    prompt: PromptEnvelope,
    editText?: string,
    opts?: { recoverConflicts?: boolean; forceQueue?: boolean },
  ) => Promise<'ok' | 'rejected' | 'queued'>;
  submitPromptInternal: (
    sessionId: string,
    prompt: PromptEnvelope,
    opts?: { delivery?: 'steer' | 'queue' },
  ) => Promise<'ok' | 'rejected' | 'queued'>;
}

let goalHooks: GoalHooks | null = null;

export function setGoalHooks(next: GoalHooks | null): void {
  goalHooks = next;
}

export const useGoalStore = defineStore('kimi.goal', () => {
  const goalBySession = ref<Record<string, AppGoal>>({});
  const goalVersionBySession = ref<Record<string, number>>({});

  function hasLoadedGoal(sessionId: string): boolean {
    return goalBySession.value[sessionId] !== undefined;
  }

  function applyGoalFrame(sessionId: string, goal: AppGoal | null): void {
    goalVersionBySession.value[sessionId] = (goalVersionBySession.value[sessionId] ?? 0) + 1;
    if (goal === null || goal.status === 'complete') delete goalBySession.value[sessionId];
    else goalBySession.value[sessionId] = goal;
  }

  async function createGoalObjective(sessionId: string, objective: string): Promise<boolean> {
    try {
      await getKimiWebApi().updateSession(sessionId, { goalObjective: objective, planMode: false });
      modeStore().planModeBySession = { ...modeStore().planModeBySession, [sessionId]: false };
    } catch (err) {
      goalHooks?.pushOperationFailure('createGoal', err, {
        sessionId,
        message: goalErrorMessage(err),
      });
      return false;
    }
    if (modeStore().goalModeBySession[sessionId]) {
      modeStore().goalModeBySession = { ...modeStore().goalModeBySession, [sessionId]: false };
      modeStore().saveGoalModeToStorage();
    }
    return true;
  }

  function controlGoal(action: 'pause' | 'resume' | 'cancel'): void {
    const sid = sessionsStore().activeSessionId;
    if (!sid) return;
    void Promise.resolve(getKimiWebApi().updateSession(sid, { goalControl: action }))
      .catch((err) => {
        goalHooks?.pushOperationFailure('controlGoal', err, {
          sessionId: sid,
          message: goalErrorMessage(err),
        });
      });
  }

  async function editGoalObjective(objective: string): Promise<boolean> {
    const sid = sessionsStore().activeSessionId;
    if (!sid) return false;
    const trimmed = objective.trim();
    if (!trimmed || trimmed.length > GOAL_OBJECTIVE_MAX_LENGTH) return false;
    try {
      await getKimiWebApi().updateSession(sid, { goalControl: 'edit', goalObjective: trimmed });
    } catch (err) {
      goalHooks?.pushOperationFailure('editGoal', err, {
        sessionId: sid,
        message: goalErrorMessage(err, GOAL_EDIT_ERROR_KEYS),
      });
      return false;
    }
    return true;
  }

  async function createGoal(
    objective: string | PromptEnvelopeContent,
    opts?: { delivery?: 'steer' | 'queue'; editText?: string },
  ): Promise<{ sessionId: string | null; promptRejected: boolean }> {
    const input = typeof objective === 'string' ? { text: objective } : structuredClone(objective);
    const trimmed = input.text.trim();
    if (!trimmed) return { sessionId: null, promptRejected: false };
    const objectiveText = (input.snapshot === undefined ? '' : composerDisplayText(input.snapshot).trim()) || trimmed;
    const activeSid = sessionsStore().activeSessionId ?? undefined;
    const activeWid = workspacesStore().activeWorkspaceId;
    const activeDraftGen = permissionsStore().draftGeneration;
    const permissionMode =
      activeSid !== undefined
        ? permissionsStore().forSession(activeSid)
        : permissionsStore().forDraftPrompt();
    if (permissionMode === undefined || permissionMode === 'manual') {
      const ok = await (goalHooks?.confirmGoalStart?.(objectiveText) ?? false);
      if (!ok) return { sessionId: null, promptRejected: false };
    }
    if (activeSid !== undefined && !sessionsStore().sessions.some((s) => s.id === activeSid)) {
      return { sessionId: null, promptRejected: false };
    }
    if (activeSid === undefined && (sessionsStore().activeSessionId ?? undefined) !== undefined) {
      return { sessionId: null, promptRejected: false };
    }
    if (activeSid === undefined && workspacesStore().activeWorkspaceId !== activeWid) {
      return { sessionId: null, promptRejected: false };
    }
    if (activeSid === undefined && permissionsStore().draftGeneration !== activeDraftGen) {
      return { sessionId: null, promptRejected: false };
    }
    let sid = activeSid;
    let createdId: string | null = null;
    if (!sid) {
      const wsId = activeWid;
      if (!wsId) return { sessionId: null, promptRejected: false };
      try {
        sid = (await goalHooks?.createDraftSession(wsId)) ?? undefined;
        createdId = sid ?? null;
      } catch (err) {
        goalHooks?.pushOperationFailure('createGoal', err);
        return { sessionId: null, promptRejected: false };
      }
      if (!sid) return { sessionId: null, promptRejected: false };
    }
    const created = await createGoalObjective(sid, objectiveText);
    if (!created) return { sessionId: sid, promptRejected: true };
    const prompt: PromptEnvelope = {
      text: trimmed,
      snapshot: input.snapshot,
      attachments: input.attachments ?? [],
      skills: input.skills ?? [],
    };
    if (opts?.delivery === 'steer') {
      const outcome = await goalHooks!.submitPromptInternal(sid, prompt, { delivery: 'steer' });
      return { sessionId: createdId ?? sid, promptRejected: outcome === 'rejected' };
    }
    if (sessionsStore().activeSessionId === sid) {
      const outcome = await goalHooks!.sendPrompt(
        prompt,
        opts?.editText,
        opts?.delivery === 'queue' ? { recoverConflicts: true, forceQueue: true } : undefined,
      );
      return { sessionId: createdId ?? sid, promptRejected: outcome === 'rejected' };
    }
    const outcome = await goalHooks!.submitPromptInternal(sid, prompt, { delivery: 'queue' });
    return { sessionId: createdId ?? sid, promptRejected: outcome === 'rejected' };
  }

  function applyGoalDiff(
    nextGoal: Record<string, AppGoal>,
    nextVersion: Record<string, number>,
  ): void {
    applyRecordDiff(goalBySession.value, nextGoal);
    applyRecordDiff(goalVersionBySession.value, nextVersion);
  }

  function forgetSessionGoal(sessionId: string): void {
    delete goalBySession.value[sessionId];
    delete goalVersionBySession.value[sessionId];
  }

  function resetGoals(): void {
    goalBySession.value = {};
    goalVersionBySession.value = {};
  }

  return {
    goalBySession,
    goalVersionBySession,
    hasLoadedGoal,
    applyGoalFrame,
    createGoalObjective,
    createGoal,
    controlGoal,
    editGoalObjective,
    applyGoalDiff,
    forgetSessionGoal,
    resetGoals,
  };
});

export function goalStore() {
  return useGoalStore(clientPinia);
}
