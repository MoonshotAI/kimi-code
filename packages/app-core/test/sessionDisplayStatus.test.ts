import { describe, expect, it } from 'vitest';
import {
  openTabAttention,
  sessionDisplayStatus,
  type SessionDisplayStatusInput,
} from '../src/lib/sessionDisplayStatus';

function input(over: Partial<SessionDisplayStatusInput> = {}): SessionDisplayStatusInput {
  return {
    busy: false,
    unread: false,
    questionCount: 0,
    approvalCount: 0,
    ...over,
  };
}

describe('sessionDisplayStatus — attention pills', () => {
  it('awaiting-question from the count or the list-level fallback', () => {
    expect(sessionDisplayStatus(input({ questionCount: 1 }))).toBe('awaiting-question');
    expect(sessionDisplayStatus(input({ pendingInteraction: 'question' }))).toBe(
      'awaiting-question',
    );
    expect(sessionDisplayStatus(input())).toBe('idle');
  });

  it('awaiting-approval from the count or the list-level fallback', () => {
    expect(sessionDisplayStatus(input({ approvalCount: 2 }))).toBe('awaiting-approval');
    expect(sessionDisplayStatus(input({ pendingInteraction: 'approval' }))).toBe(
      'awaiting-approval',
    );
    expect(sessionDisplayStatus(input({ pendingInteraction: 'none' }))).toBe('idle');
  });

  it('approval wins over question when both pend (server collapse parity)', () => {
    expect(
      sessionDisplayStatus(input({ approvalCount: 1, questionCount: 1 })),
    ).toBe('awaiting-approval');
  });

  it('detailed counts outrank the list-level fallback (a resolved pill must not stick)', () => {
    // Approval resolved locally (its list emptied) while a question stays
    // pending: a lagging 'approval' aggregate must not keep the dead pill up.
    expect(
      sessionDisplayStatus(input({ pendingInteraction: 'approval', questionCount: 1 })),
    ).toBe('awaiting-question');
    // Symmetric: a confirmed approval beats the question fallback.
    expect(
      sessionDisplayStatus(input({ approvalCount: 1, pendingInteraction: 'question' })),
    ).toBe('awaiting-approval');
  });

  it('falls back to the aggregate only when both pending lists are empty', () => {
    expect(sessionDisplayStatus(input({ pendingInteraction: 'approval' }))).toBe(
      'awaiting-approval',
    );
    expect(sessionDisplayStatus(input({ pendingInteraction: 'question' }))).toBe(
      'awaiting-question',
    );
  });
});

describe('sessionDisplayStatus — running', () => {
  it('is running when busy with no pending interaction', () => {
    expect(sessionDisplayStatus(input({ busy: true }))).toBe('running');
    expect(sessionDisplayStatus(input({ busy: true, unread: true }))).toBe('running');
  });

  it('pending pills own the row — busy yields', () => {
    expect(sessionDisplayStatus(input({ busy: true, pendingInteraction: 'approval' }))).toBe(
      'awaiting-approval',
    );
    expect(sessionDisplayStatus(input({ busy: true, questionCount: 1 }))).toBe(
      'awaiting-question',
    );
  });
});

describe('sessionDisplayStatus — aborted', () => {
  it('is aborted only for a quiet session whose last turn failed', () => {
    expect(sessionDisplayStatus(input({ lastTurnReason: 'failed' }))).toBe('aborted');
    // A manually stopped turn is the user's own doing — never raises the tag.
    expect(sessionDisplayStatus(input({ lastTurnReason: 'cancelled' }))).toBe('idle');
    expect(sessionDisplayStatus(input({ lastTurnReason: 'completed' }))).toBe('idle');
    // busy / pending input suppress it (running and pills rank higher).
    expect(sessionDisplayStatus(input({ busy: true, lastTurnReason: 'failed' }))).toBe('running');
    expect(
      sessionDisplayStatus(input({ pendingInteraction: 'question', lastTurnReason: 'failed' })),
    ).toBe('awaiting-question');
  });

  it('aborted wins over unread — the failure is the thing to see', () => {
    expect(sessionDisplayStatus(input({ lastTurnReason: 'failed', unread: true }))).toBe('aborted');
  });
});

describe('sessionDisplayStatus — unread / idle', () => {
  it('is unread for a quiet, finished, unseen session', () => {
    expect(sessionDisplayStatus(input({ unread: true }))).toBe('unread');
    expect(sessionDisplayStatus(input({ unread: true, lastTurnReason: 'completed' }))).toBe(
      'unread',
    );
  });

  it('is idle only when nothing reports', () => {
    expect(sessionDisplayStatus(input())).toBe('idle');
    expect(sessionDisplayStatus(input({ lastTurnReason: 'cancelled' }))).toBe('idle');
  });
});

describe('openTabAttention — status view 进行中 tab aggregation', () => {
  it('is null for an empty list, idle rows, and running-only rows', () => {
    expect(openTabAttention([])).toBeNull();
    expect(openTabAttention([input()])).toBeNull();
    expect(openTabAttention([input({ busy: true })])).toBeNull();
  });

  it('reports unread / aborted / question / approval', () => {
    expect(openTabAttention([input({ unread: true })])).toBe('unread');
    expect(openTabAttention([input({ lastTurnReason: 'failed' })])).toBe('aborted');
    expect(openTabAttention([input({ questionCount: 1 })])).toBe('question');
    expect(openTabAttention([input({ approvalCount: 1 })])).toBe('approval');
  });

  it('priority: approval > question > aborted > unread', () => {
    expect(
      openTabAttention([
        input({ unread: true }),
        input({ lastTurnReason: 'failed' }),
        input({ questionCount: 1 }),
        input({ approvalCount: 1 }),
      ]),
    ).toBe('approval');
    expect(
      openTabAttention([input({ unread: true }), input({ lastTurnReason: 'failed' })]),
    ).toBe('aborted');
    expect(
      openTabAttention([input({ unread: true }), input({ questionCount: 1 })]),
    ).toBe('question');
  });
});
