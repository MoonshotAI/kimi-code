// Approvals domain store (P11).
//
// Truth source for pending tool approvals and questions per session. Fed by
// the reducer write-back (applyEvent) and the snapshot seed, mutated locally
// by the respond paths. Record slices follow the applyRecordDiff per-key
// discipline — never a wholesale `{ ...map }` replacement (see spec §5).

import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { AppApprovalRequest, AppQuestionRequest } from '@moonshot-ai/app-core/api';
import { applyRecordDiff } from '@moonshot-ai/app-core/client';
import { clientPinia } from './pinia';

export const useApprovalsStore = defineStore('kimi.approvals', () => {
  const approvalsBySession = ref<Record<string, AppApprovalRequest[]>>({});
  const questionsBySession = ref<Record<string, AppQuestionRequest[]>>({});

  /** Reducer write-back: apply changed keys only, keeping the record's own
   *  identity (a wholesale replacement re-triggers computeds that read a
   *  DIFFERENT session's key). */
  function applyApprovalsDiff(next: Record<string, AppApprovalRequest[]>): void {
    applyRecordDiff(approvalsBySession.value, next);
  }

  function applyQuestionsDiff(next: Record<string, AppQuestionRequest[]>): void {
    applyRecordDiff(questionsBySession.value, next);
  }

  /** Snapshot seed: replace one session's pending list wholesale. */
  function setSessionApprovals(sid: string, list: AppApprovalRequest[]): void {
    approvalsBySession.value[sid] = list;
  }

  function setSessionQuestions(sid: string, list: AppQuestionRequest[]): void {
    questionsBySession.value[sid] = list;
  }

  /** Optimistic removal after a respond POST (the WS event confirms). Per-key
   *  write, not a record replacement. */
  function removePendingApproval(sid: string, approvalId: string): void {
    const list = approvalsBySession.value[sid] ?? [];
    approvalsBySession.value[sid] = list.filter((a) => a.approvalId !== approvalId);
  }

  function removePendingQuestion(sid: string, questionId: string): void {
    const list = questionsBySession.value[sid] ?? [];
    questionsBySession.value[sid] = list.filter((q) => q.questionId !== questionId);
  }

  /** Drop a session's pending approvals (forgetSession / authoritative
   *  pendingInteraction reconciliation). */
  function clearSessionApprovals(sid: string): void {
    delete approvalsBySession.value[sid];
  }

  function clearSessionQuestions(sid: string): void {
    delete questionsBySession.value[sid];
  }

  return {
    approvalsBySession,
    questionsBySession,
    applyApprovalsDiff,
    applyQuestionsDiff,
    setSessionApprovals,
    setSessionQuestions,
    removePendingApproval,
    removePendingQuestion,
    clearSessionApprovals,
    clearSessionQuestions,
  };
});

/** Module-level-safe accessor: resolves the store against the package-held
 *  pinia instance, so import-time singleton code (the client composables) can
 *  call it before any app has installed the pinia plugin. */
export function approvalsStore() {
  return useApprovalsStore(clientPinia);
}
