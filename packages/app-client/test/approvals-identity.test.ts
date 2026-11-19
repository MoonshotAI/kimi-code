import { beforeEach, describe, expect, it, vi } from 'vitest';

const memStorage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => memStorage.get(key) ?? null,
  setItem: (key: string, value: string) => void memStorage.set(key, value),
  removeItem: (key: string) => void memStorage.delete(key),
  clear: () => memStorage.clear(),
});

import type { AppApprovalRequest, AppQuestionRequest } from '@moonshot-ai/app-core/api';
import { approvalsStore } from '../src/stores/approvals';
import { sessionViewsStore } from '../src/stores/sessionViews';

function approval(id: string): AppApprovalRequest {
  return {
    approvalId: id,
    sessionId: 's1',
    toolCallId: `tc-${id}`,
    toolName: 'Bash',
  } as unknown as AppApprovalRequest;
}

function question(id: string): AppQuestionRequest {
  return {
    questionId: id,
    sessionId: 's1',
  } as unknown as AppQuestionRequest;
}

beforeEach(() => {
  memStorage.clear();
  approvalsStore().approvalsBySession = {};
  approvalsStore().questionsBySession = {};
  sessionViewsStore().reloadUnread();
});

describe('approvals store list identity', () => {
  it('keeps the stored approvals array when an equal list is set again', () => {
    const store = approvalsStore();
    const a1 = approval('a1');
    store.setSessionApprovals('s1', [a1]);
    const before = store.approvalsBySession['s1'];

    store.setSessionApprovals('s1', [a1]);

    expect(store.approvalsBySession['s1']).toBe(before);
  });

  it('keeps an empty approvals array stable across repeated empty snapshots', () => {
    const store = approvalsStore();
    store.setSessionApprovals('s1', []);
    const before = store.approvalsBySession['s1'];

    store.setSessionApprovals('s1', []);

    expect(store.approvalsBySession['s1']).toBe(before);
  });

  it('still replaces the array when the list actually changes', () => {
    const store = approvalsStore();
    const a1 = approval('a1');
    store.setSessionApprovals('s1', [a1]);
    const before = store.approvalsBySession['s1'];

    store.setSessionApprovals('s1', [a1, approval('a2')]);

    expect(store.approvalsBySession['s1']).not.toBe(before);
    expect(store.approvalsBySession['s1']).toHaveLength(2);
  });

  it('applies the same rule to questions', () => {
    const store = approvalsStore();
    const q1 = question('q1');
    store.setSessionQuestions('s1', [q1]);
    const before = store.questionsBySession['s1'];

    store.setSessionQuestions('s1', [q1]);
    expect(store.questionsBySession['s1']).toBe(before);

    store.setSessionQuestions('s1', []);
    expect(store.questionsBySession['s1']).not.toBe(before);
  });

  it('keeps pendingBySession and attentionBySession identity when equal lists are re-set', () => {
    const store = approvalsStore();
    const views = sessionViewsStore();
    const a1 = approval('a1');
    store.setSessionApprovals('s1', [a1]);
    store.setSessionQuestions('s1', []);
    const pendingBefore = views.pendingBySession;
    const attentionBefore = views.attentionBySession;
    expect(pendingBefore['s1']).toEqual({ approvals: 1, questions: 0 });

    store.setSessionApprovals('s1', [a1]);
    store.setSessionQuestions('s1', []);

    expect(views.pendingBySession).toBe(pendingBefore);
    expect(views.attentionBySession).toBe(attentionBefore);
  });
});
