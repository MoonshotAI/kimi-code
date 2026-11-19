
import { ref, toRaw } from 'vue';
import { defineStore } from 'pinia';
import type { AppApprovalRequest, AppQuestionRequest, ApprovalDecision, ApprovalResponse, QuestionResponse } from '@moonshot-ai/app-core/api';
import { isDaemonApiError } from '@moonshot-ai/app-core/api';
import { applyRecordDiff } from '@moonshot-ai/app-core/client';
import { getKimiWebApi } from '../client/deps';
import { clientPinia } from './pinia';
import { sessionsStore } from './sessions';

const ALREADY_RESOLVED_CODE = 40902;

function isAlreadyResolvedError(err: unknown): boolean {
  return isDaemonApiError(err) && err.code === ALREADY_RESOLVED_CODE;
}

export interface ApprovalsHooks {
  pushOperationFailure: (
    operation: string,
    err: unknown,
    opts?: { title?: string; message?: string; sessionId?: string },
  ) => void;
}

let approvalsHooks: ApprovalsHooks | null = null;

export function setApprovalsHooks(next: ApprovalsHooks | null): void {
  approvalsHooks = next;
}

export const useApprovalsStore = defineStore('kimi.approvals', () => {
  const approvalsBySession = ref<Record<string, AppApprovalRequest[]>>({});
  const questionsBySession = ref<Record<string, AppQuestionRequest[]>>({});
  const pendingApprovalActions = ref<Record<string, true>>({});
  const answeredApprovalsBySession = ref<Record<string, Record<string, true>>>({});
  const pendingQuestionActions = ref<Record<string, 'answer' | 'dismiss'>>({});

  function applyApprovalsDiff(next: Record<string, AppApprovalRequest[]>): void {
    applyRecordDiff(approvalsBySession.value, next);
  }

  function applyQuestionsDiff(next: Record<string, AppQuestionRequest[]>): void {
    applyRecordDiff(questionsBySession.value, next);
  }

  function sameEntries<T extends object>(current: readonly T[] | undefined, next: readonly T[]): boolean {
    if (current === undefined) return false;
    const raw = toRaw(current);
    if (raw.length !== next.length) return false;
    for (let i = 0; i < raw.length; i += 1) {
      if (toRaw(raw[i]!) !== toRaw(next[i]!)) return false;
    }
    return true;
  }

  function setSessionApprovals(sid: string, list: AppApprovalRequest[]): void {
    if (sameEntries(approvalsBySession.value[sid], list)) return;
    approvalsBySession.value[sid] = list;
  }

  function setSessionQuestions(sid: string, list: AppQuestionRequest[]): void {
    if (sameEntries(questionsBySession.value[sid], list)) return;
    questionsBySession.value[sid] = list;
  }

  function removePendingApproval(sid: string, approvalId: string): void {
    const list = approvalsBySession.value[sid] ?? [];
    approvalsBySession.value[sid] = list.filter((a) => a.approvalId !== approvalId);
  }

  function removePendingQuestion(sid: string, questionId: string): void {
    const list = questionsBySession.value[sid] ?? [];
    questionsBySession.value[sid] = list.filter((q) => q.questionId !== questionId);
  }

  function clearSessionApprovals(sid: string): void {
    delete approvalsBySession.value[sid];
    delete answeredApprovalsBySession.value[sid];
  }

  function isApprovalAnswered(sid: string, approvalId: string): boolean {
    return answeredApprovalsBySession.value[sid]?.[approvalId] === true;
  }

  function clearSessionQuestions(sid: string): void {
    delete questionsBySession.value[sid];
  }

  async function respondApproval(
    approvalId: string,
    response: { decision: ApprovalDecision; scope?: 'session'; feedback?: string; selectedLabel?: string },
  ): Promise<void> {
    const sid = sessionsStore().activeSessionId;
    if (!sid) return;
    if (pendingApprovalActions.value[approvalId]) return;
    pendingApprovalActions.value[approvalId] = true;
    (answeredApprovalsBySession.value[sid] ??= {})[approvalId] = true;
    try {
      const api = getKimiWebApi();
      const fullResponse: ApprovalResponse = {
        decision: response.decision,
        scope: response.scope,
        feedback: response.feedback,
        selectedLabel: response.selectedLabel,
      };
      await api.respondApproval(sid, approvalId, fullResponse);
      removePendingApproval(sid, approvalId);
    } catch (err) {
      if (isAlreadyResolvedError(err)) {
        removePendingApproval(sid, approvalId);
      } else {
        delete answeredApprovalsBySession.value[sid]?.[approvalId];
        approvalsHooks?.pushOperationFailure('respondApproval', err, { sessionId: sid });
      }
    } finally {
      delete pendingApprovalActions.value[approvalId];
    }
  }

  async function respondQuestion(
    questionId: string,
    response: QuestionResponse,
  ): Promise<void> {
    const sid = sessionsStore().activeSessionId;
    if (!sid) return;
    if (pendingQuestionActions.value[questionId]) return;
    pendingQuestionActions.value[questionId] = 'answer';
    try {
      const api = getKimiWebApi();
      await api.respondQuestion(sid, questionId, response);
      removePendingQuestion(sid, questionId);
    } catch (err) {
      if (isAlreadyResolvedError(err)) {
        removePendingQuestion(sid, questionId);
      } else {
        approvalsHooks?.pushOperationFailure('respondQuestion', err, { sessionId: sid });
      }
    } finally {
      delete pendingQuestionActions.value[questionId];
    }
  }

  async function dismissQuestion(questionId: string): Promise<void> {
    const sid = sessionsStore().activeSessionId;
    if (!sid) return;
    if (pendingQuestionActions.value[questionId]) return;
    pendingQuestionActions.value[questionId] = 'dismiss';
    try {
      const api = getKimiWebApi();
      await api.dismissQuestion(sid, questionId);
      removePendingQuestion(sid, questionId);
    } catch (err) {
      if (isAlreadyResolvedError(err)) {
        removePendingQuestion(sid, questionId);
      } else {
        approvalsHooks?.pushOperationFailure('dismissQuestion', err, { sessionId: sid });
      }
    } finally {
      delete pendingQuestionActions.value[questionId];
    }
  }

  return {
    approvalsBySession,
    questionsBySession,
    pendingApprovalActions,
    pendingQuestionActions,
    applyApprovalsDiff,
    applyQuestionsDiff,
    setSessionApprovals,
    setSessionQuestions,
    removePendingApproval,
    removePendingQuestion,
    clearSessionApprovals,
    clearSessionQuestions,
    isApprovalAnswered,
    respondApproval,
    respondQuestion,
    dismissQuestion,
  };
});

export function approvalsStore() {
  return useApprovalsStore(clientPinia);
}
