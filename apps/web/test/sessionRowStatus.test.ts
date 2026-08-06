// apps/kimi-web/test/sessionRowStatus.test.ts
import { describe, expect, it } from 'vitest';
import {
  sessionRowStatus,
  type SessionRowStatusInput,
} from '../src/components/sessionRowStatus';

function input(over: Partial<SessionRowStatusInput> = {}): SessionRowStatusInput {
  return {
    busy: false,
    unread: false,
    renaming: false,
    questionCount: 0,
    approvalCount: 0,
    ...over,
  };
}

describe('sessionRowStatus — attention badges', () => {
  it('shows the question badge from the count or the list-level fallback', () => {
    expect(sessionRowStatus(input({ questionCount: 1 })).showQuestionBadge).toBe(true);
    expect(sessionRowStatus(input({ pendingInteraction: 'question' })).showQuestionBadge).toBe(true);
    expect(sessionRowStatus(input()).showQuestionBadge).toBe(false);
  });

  it('shows the approval badge from the count or the list-level fallback', () => {
    expect(sessionRowStatus(input({ approvalCount: 2 })).showApprovalBadge).toBe(true);
    expect(sessionRowStatus(input({ pendingInteraction: 'approval' })).showApprovalBadge).toBe(true);
    expect(sessionRowStatus(input({ pendingInteraction: 'none' })).showApprovalBadge).toBe(false);
  });

  it('hides badges while renaming', () => {
    const s = sessionRowStatus(
      input({ renaming: true, questionCount: 1, approvalCount: 1, lastTurnReason: 'failed' }),
    );
    expect(s.showQuestionBadge).toBe(false);
    expect(s.showApprovalBadge).toBe(false);
    expect(s.showAbortedBadge).toBe(false);
  });

  it('shows the aborted badge only for a quiet session whose last turn failed', () => {
    expect(sessionRowStatus(input({ lastTurnReason: 'failed' })).showAbortedBadge).toBe(true);
    // A manually stopped turn is the user's own doing — never raises the tag.
    expect(sessionRowStatus(input({ lastTurnReason: 'cancelled' })).showAbortedBadge).toBe(false);
    expect(sessionRowStatus(input({ lastTurnReason: 'completed' })).showAbortedBadge).toBe(false);
    // busy / pending input suppress it
    expect(sessionRowStatus(input({ busy: true, lastTurnReason: 'failed' })).showAbortedBadge).toBe(false);
    expect(
      sessionRowStatus(input({ pendingInteraction: 'question', lastTurnReason: 'failed' }))
        .showAbortedBadge,
    ).toBe(false);
  });
});

describe('sessionRowStatus — spinner yields to attention pills', () => {
  it('shows the spinner when busy with no attention pill', () => {
    expect(sessionRowStatus(input({ busy: true })).showBusySpinner).toBe(true);
  });

  it('never shows the spinner together with an approval/question pill', () => {
    expect(
      sessionRowStatus(input({ busy: true, pendingInteraction: 'approval' })).showBusySpinner,
    ).toBe(false);
    expect(
      sessionRowStatus(input({ busy: true, questionCount: 1 })).showBusySpinner,
    ).toBe(false);
  });

  it('unread does not suppress the spinner', () => {
    expect(sessionRowStatus(input({ busy: true, unread: true })).showBusySpinner).toBe(true);
  });
});

describe('sessionRowStatus — hasStatus (flat row suppresses the time)', () => {
  it('is false for an idle, read session', () => {
    expect(sessionRowStatus(input()).hasStatus).toBe(false);
  });

  it('is true for busy, unread, or any badge', () => {
    expect(sessionRowStatus(input({ busy: true })).hasStatus).toBe(true);
    expect(sessionRowStatus(input({ unread: true })).hasStatus).toBe(true);
    expect(sessionRowStatus(input({ approvalCount: 1 })).hasStatus).toBe(true);
    expect(sessionRowStatus(input({ lastTurnReason: 'failed' })).hasStatus).toBe(true);
  });

  it('stays true when busy is only reported via a suppressed spinner (pill owns the row)', () => {
    expect(
      sessionRowStatus(input({ busy: true, pendingInteraction: 'approval' })).hasStatus,
    ).toBe(true);
  });
});
