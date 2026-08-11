import { describe, expect, it } from 'vitest';
import type {
  AppApprovalRequest,
  AppMessage,
  AppMessageContent,
  SessionPlan,
} from '../src/api/types';
import { messagesToTurns } from '../src/client';
import { createTurnsProjector, type TurnsProjectInput } from '../src/client';

function message(
  id: string,
  role: AppMessage['role'],
  content: AppMessageContent[],
  extra: Partial<AppMessage> = {},
): AppMessage {
  return {
    id,
    sessionId: 'session-1',
    role,
    content,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

const text = (t: string): AppMessageContent => ({ type: 'text', text: t });

// Shared empty list: a fresh `[]` per call would trip the projector's
// approvals-identity reuse gate (mirrors the hoisted fallback at the call
// sites in useKimiWebClient).
const NO_APPROVALS: AppApprovalRequest[] = [];

function baseInput(messages: AppMessage[]): TurnsProjectInput {
  return { messages, approvals: NO_APPROVALS, sessionActive: true };
}

describe('createTurnsProjector', () => {
  it('matches a plain messagesToTurns run on the first projection', () => {
    const messages = [
      message('u1', 'user', [text('hello')]),
      message('a1', 'assistant', [text('hi there')]),
      message('u2', 'user', [text('again')]),
      message('a2', 'assistant', [text('second')]),
    ];
    const projector = createTurnsProjector();
    const projected = projector(baseInput(messages));
    const plain = messagesToTurns(messages, [], undefined, true);
    expect(projected).toEqual(plain);
  });

  it('keeps settled turn identities when a streaming delta extends the tail', () => {
    const u1 = message('u1', 'user', [text('hello')]);
    const a1 = message('a1', 'assistant', [text('partial')]);
    const projector = createTurnsProjector();
    const first = projector(baseInput([u1, a1]));
    expect(first).toHaveLength(2);

    // Streaming: the LAST assistant message is replaced with a longer copy
    // (the reducer swaps message objects on append), nothing else changes.
    const a1Longer = message('a1', 'assistant', [text('partial reply with more')]);
    const second = projector(baseInput([u1, a1Longer]));

    expect(second[0]).toBe(first[0]); // settled user turn reused by reference
    expect(second[1]).not.toBe(first[1]); // live tail rebuilt
    expect(second[1]?.text).toBe('partial reply with more');
    // Numbering stays correct through reuse.
    expect(second.map((t) => t.no)).toEqual([1, 2]);
  });

  it('reuses every turn when only the messages array identity changed', () => {
    const u1 = message('u1', 'user', [text('hello')]);
    const a1 = message('a1', 'assistant', [text('done')]);
    const u2 = message('u2', 'user', [text('next')]);
    const a2 = message('a2', 'assistant', [text('done too')]);
    const projector = createTurnsProjector();
    const first = projector(baseInput([u1, a1, u2, a2]));
    const second = projector(baseInput([u1, a1, u2, a2]));
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(second[2]).toBe(first[2]);
    // Even the trailing assistant turn: tail span intact + sessionActive steady.
    expect(second[3]).toBe(first[3]);
  });

  it('rebuilds the trailing assistant turn when sessionActive flips (settle rule)', () => {
    const u1 = message('u1', 'user', [text('run something')]);
    const a1 = message('a1', 'assistant', [
      { type: 'toolUse', toolCallId: 'tool-1', toolName: 'bash', input: 'ls' },
    ]);
    const projector = createTurnsProjector();
    const live = projector(baseInput([u1, a1]));
    expect(live[1]?.tools?.[0]?.status).toBe('running');

    // Turn ends: sessionActive flips false — the dangling tool settles.
    const settled = projector({ messages: [u1, a1], approvals: NO_APPROVALS, sessionActive: false });
    expect(settled[1]).not.toBe(live[1]);
    expect(settled[1]?.tools?.[0]?.status).toBe('ok');
    expect(settled[0]).toBe(live[0]);
  });

  it('rebuilds everything when the approvals array reference changes', () => {
    const u1 = message('u1', 'user', [text('hello')]);
    const a1 = message('a1', 'assistant', [text('done')]);
    const projector = createTurnsProjector();
    const first = projector(baseInput([u1, a1]));
    const second = projector({ messages: [u1, a1], approvals: [], sessionActive: true });
    // Fresh [] literal each call = new reference = conservative full rebuild.
    expect(second[0]).not.toBe(first[0]);
  });

  it('rebuilds when planReview content changes even though the record identity is stable', () => {
    const u1 = message('u1', 'user', [text('plan')]);
    const a1 = message('a1', 'assistant', [
      { type: 'toolUse', toolCallId: 'tool-1', toolName: 'ExitPlanMode', input: '{}' },
    ]);
    const planReview: Record<string, { plan: string; path?: string }> = {};
    const projector = createTurnsProjector();
    const first = projector({ messages: [u1, a1], approvals: NO_APPROVALS, planReviewByToolCallId: planReview });
    expect(first[1]?.tools?.[0]?.planPath).toBeUndefined();

    // applyRecordDiff-style in-place per-key write: same record identity.
    planReview['tool-1'] = { plan: '...', path: '/tmp/plan.md' };
    const second = projector({ messages: [u1, a1], approvals: NO_APPROVALS, planReviewByToolCallId: planReview });
    expect(second[1]?.tools?.[0]?.planPath).toBe('/tmp/plan.md');
  });

  it('rebuilds the historical tool when persisted plan details arrive', () => {
    const u1 = message('u1', 'user', [text('plan')]);
    const a1 = message('a1', 'assistant', [
      { type: 'toolUse', toolCallId: 'tool-1', toolName: 'ExitPlanMode', input: '{}' },
    ]);
    const plans: Record<string, SessionPlan> = {};
    const projector = createTurnsProjector();
    const first = projector({
      messages: [u1, a1],
      approvals: NO_APPROVALS,
      plansByToolCallId: plans,
    });
    expect(first[1]?.tools?.[0]?.plan).toBeUndefined();

    plans['tool-1'] = {
      agentId: 'main',
      toolCallId: 'tool-1',
      turnId: 'turn-1',
      source: 'output',
      plan: '# Restored plan',
    };
    const second = projector({
      messages: [u1, a1],
      approvals: NO_APPROVALS,
      plansByToolCallId: plans,
    });

    expect(second[1]).not.toBe(first[1]);
    expect(second[1]?.tools?.[0]?.plan?.plan).toBe('# Restored plan');
  });

  it('rebuilds from the first mismatching span onward (middle removal)', () => {
    const u1 = message('u1', 'user', [text('one')]);
    const a1 = message('a1', 'assistant', [text('answer one')]);
    const u2 = message('u2', 'user', [text('two')]);
    const a2 = message('a2', 'assistant', [text('answer two')]);
    const projector = createTurnsProjector();
    const first = projector(baseInput([u1, a1, u2, a2]));

    // A hidden side-chat user message gets filtered out mid-list.
    const second = projector(baseInput([u1, a1, a2]));
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(second[2]).not.toBe(first[3]);
    expect(second[2]?.text).toBe('answer two');
    // Renumbered: removed user turn frees its number.
    expect(second.map((t) => t.no)).toEqual([1, 2, 3]);
  });

  it('handles a history prepend by rebuilding (prefix no longer matches)', () => {
    const u1 = message('u1', 'user', [text('newest question')]);
    const a1 = message('a1', 'assistant', [text('newest answer')]);
    const projector = createTurnsProjector();
    const first = projector(baseInput([u1, a1]));

    const older = message('u0', 'user', [text('older question')]);
    const second = projector(baseInput([older, u1, a1]));
    expect(second).toHaveLength(3);
    expect(second[1]).not.toBe(first[0]);
    expect(second.map((t) => t.no)).toEqual([1, 2, 3]);
  });

  it('reset() drops the cached prefix', () => {
    const u1 = message('u1', 'user', [text('hello')]);
    const projector = createTurnsProjector();
    const first = projector(baseInput([u1]));
    projector.reset();
    const second = projector(baseInput([u1]));
    expect(second[0]).not.toBe(first[0]);
  });
});
