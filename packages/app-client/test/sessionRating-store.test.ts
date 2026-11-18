import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonKimiWebApi, type AppSession, type AppSessionRatingOffer, type KimiWebApi } from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { approvalsStore } from '../src/stores/approvals';
import { connectionStore } from '../src/stores/connection';
import { promptStore } from '../src/stores/prompt';
import { sessionRatingStore } from '../src/stores/sessionRating';
import { sessionsStore } from '../src/stores/sessions';

const SESSION = 'session_a';
const OFFER: AppSessionRatingOffer = { appearanceId: 'appearance_1', survey: 'session' };
const OPEN = { phase: 'open', ...OFFER };
const evaluate = vi.fn<KimiWebApi['evaluateSessionRating']>();
const report = vi.fn<KimiWebApi['reportSessionRating']>();
let blocked = false;

function watching(): boolean {
  return sessionsStore().activeSessionId === SESSION;
}

function finishTurn(turnId = 't1', isUserWatching = watching): void {
  const store = sessionRatingStore();
  store.observeTurn(SESSION, turnId, false);
  store.noteMainTurnEnded(SESSION, turnId, isUserWatching);
}

async function open(): Promise<void> {
  finishTurn();
  await vi.advanceTimersByTimeAsync(2000);
  sessionRatingStore().shown(SESSION, OFFER.appearanceId);
  expect(sessionRatingStore().viewOf(SESSION)).toEqual(OPEN);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  sessionRatingStore().$reset();
  evaluate.mockReset().mockResolvedValue(OFFER);
  report.mockReset().mockResolvedValue(undefined);
  const api = new DaemonKimiWebApi({
    origin: 'http://example.test',
    identity: { clientId: 'test', clientName: 'test', clientVersion: '0.0.0', clientUiMode: 'test' },
  });
  vi.spyOn(api, 'evaluateSessionRating').mockImplementation(evaluate);
  vi.spyOn(api, 'reportSessionRating').mockImplementation(report);
  setKimiClientDeps({ api: () => api, t: (key) => key });
  promptStore().inFlightBySession = {};
  promptStore().queuedBySession = {};
  approvalsStore().approvalsBySession = {};
  approvalsStore().questionsBySession = {};
  sessionsStore().setActiveSessionId(SESSION);
  connectionStore().markConnected();
  blocked = false;
  sessionRatingStore().enable({ canPrompt: () => !blocked });
});

afterEach(() => {
  sessionRatingStore().$reset();
  resetKimiClientDeps();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const vetoes: [string, () => void][] = [
  ['approval', () => {
    approvalsStore().approvalsBySession[SESSION] = [{
      approvalId: 'approval-1', sessionId: SESSION, toolCallId: 'call-1', toolName: 'Shell',
      action: 'run', display: null,
    }];
  }],
  ['question', () => {
    approvalsStore().questionsBySession[SESSION] = [{
      questionId: 'question-1', sessionId: SESSION, questions: [],
    }];
  }],
  ['popup', () => { blocked = true; }],
  ['sending', () => { promptStore().inFlightBySession[SESSION] = true; }],
  ['queued prompt', () => {
    promptStore().queuedBySession[SESSION] = [{ text: 'next', attachments: [], skills: [], permissionMode: undefined }];
  }],
  ['disconnected', () => { connectionStore().markDisconnected(); }],
  ['another session', () => { sessionsStore().setActiveSessionId('session_b'); }],
];

describe('session rating evaluation', () => {
  it('evaluates the completed turn after two seconds and reports only after mounting', async () => {
    finishTurn();
    await vi.advanceTimersByTimeAsync(1999);
    expect(evaluate.mock.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(evaluate.mock.calls).toEqual([[SESSION, 't1']]);
    expect(sessionRatingStore().viewOf(SESSION)).toEqual(OPEN);
    expect(report.mock.calls).toEqual([]);
    sessionRatingStore().shown(SESSION, OFFER.appearanceId);
    sessionRatingStore().shown(SESSION, OFFER.appearanceId);
    expect(report.mock.calls).toEqual([[SESSION, { op: 'shown', appearanceId: 'appearance_1' }]]);
  });

  it.each(vetoes)('does not evaluate while blocked by %s', async (_name, veto) => {
    veto();
    finishTurn();
    await vi.advanceTimersByTimeAsync(2000);
    expect(evaluate.mock.calls).toEqual([]);
    expect(sessionRatingStore().viewOf(SESSION)).toEqual({ phase: 'closed' });
  });

  it.each(vetoes)('rechecks %s when the evaluation finishes', async (_name, veto) => {
    const pending = Promise.withResolvers<AppSessionRatingOffer | null>();
    evaluate.mockReturnValueOnce(pending.promise);
    finishTurn();
    await vi.advanceTimersByTimeAsync(2000);
    veto();
    pending.resolve(OFFER);
    await vi.advanceTimersByTimeAsync(0);
    expect(evaluate.mock.calls).toEqual([[SESSION, 't1']]);
    expect(sessionRatingStore().viewOf(SESSION)).toEqual({ phase: 'closed' });
    expect(report.mock.calls).toEqual([]);
  });

  it('ignores an evaluation that takes 100 seconds without inventing abandonment', async () => {
    const pending = Promise.withResolvers<AppSessionRatingOffer | null>();
    evaluate.mockReturnValueOnce(pending.promise);
    finishTurn();
    await vi.advanceTimersByTimeAsync(102_000);
    pending.resolve(OFFER);
    await vi.advanceTimersByTimeAsync(0);
    expect(sessionRatingStore().viewOf(SESSION)).toEqual({ phase: 'closed' });
    expect(report.mock.calls).toEqual([]);
    finishTurn('t2');
    await vi.advanceTimersByTimeAsync(2000);
    expect(sessionRatingStore().viewOf(SESSION)).toEqual(OPEN);
  });

  it.each([
    ['switch away and back', () => {
      sessionsStore().setActiveSessionId('session_b');
      sessionsStore().setActiveSessionId(SESSION);
    }],
    ['session reload', () => sessionRatingStore().endSession(SESSION)],
    ['reset and re-enable', () => {
      sessionRatingStore().$reset();
      sessionRatingStore().enable();
    }],
    ['turn that starts and ends before the response', () => {
      const row = { id: SESSION, mainTurnActive: true } as AppSession;
      sessionsStore().setSessions([row]);
      sessionsStore().setSessions([{ ...row, mainTurnActive: false }]);
    }],
    ['disconnect and reconnect', () => {
      connectionStore().markDisconnected();
      connectionStore().markConnected();
    }],
  ] satisfies [string, () => void][])('does not reuse a request after %s', async (_name, invalidate) => {
    const old = Promise.withResolvers<AppSessionRatingOffer | null>();
    const current = Promise.withResolvers<AppSessionRatingOffer | null>();
    evaluate.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    finishTurn();
    await vi.advanceTimersByTimeAsync(2000);
    invalidate();
    finishTurn('t2');
    await vi.advanceTimersByTimeAsync(2000);
    current.resolve({ appearanceId: 'new', survey: 'long_context' });
    await vi.advanceTimersByTimeAsync(0);
    old.resolve(OFFER);
    await vi.advanceTimersByTimeAsync(0);
    expect(sessionRatingStore().viewOf(SESSION)).toEqual({ phase: 'open', appearanceId: 'new', survey: 'long_context' });
  });

  it('cancels an evaluation when the window loses focus', async () => {
    const pending = Promise.withResolvers<AppSessionRatingOffer | null>();
    evaluate.mockReturnValueOnce(pending.promise);
    finishTurn();
    await vi.advanceTimersByTimeAsync(2000);
    window.dispatchEvent(new Event('blur'));
    pending.resolve(OFFER);
    await vi.advanceTimersByTimeAsync(0);
    expect(sessionRatingStore().viewOf(SESSION)).toEqual({ phase: 'closed' });
    expect(report.mock.calls).toEqual([]);
  });

  it('keeps a displayed rating across session switches without another request', async () => {
    await open();
    sessionsStore().setActiveSessionId('session_b');
    sessionsStore().setActiveSessionId(SESSION);
    sessionRatingStore().shown(SESSION, OFFER.appearanceId);
    expect(sessionRatingStore().viewOf(SESSION)).toEqual(OPEN);
    expect(evaluate.mock.calls).toEqual([[SESSION, 't1']]);
    expect(report.mock.calls).toEqual([[SESSION, { op: 'shown', appearanceId: 'appearance_1' }]]);
  });
});

describe('local session rating interaction', () => {
  beforeEach(open);

  it('does not send a selection or undo, then reports only the final answer', async () => {
    const store = sessionRatingStore();
    store.select(SESSION, OFFER.appearanceId, 'bad');
    await vi.advanceTimersByTimeAsync(2999);
    store.undo(SESSION, OFFER.appearanceId);
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.viewOf(SESSION)).toEqual(OPEN);
    expect(report.mock.calls).toEqual([[SESSION, { op: 'shown', appearanceId: 'appearance_1' }]]);
    report.mockReturnValue(new Promise(() => {}));
    store.select(SESSION, OFFER.appearanceId, 'good');
    await vi.advanceTimersByTimeAsync(3000);
    expect(store.viewOf(SESSION)).toEqual({ phase: 'thanks', ...OFFER, response: 'good' });
    store.undo(SESSION, OFFER.appearanceId);
    await vi.advanceTimersByTimeAsync(1600);
    expect(store.viewOf(SESSION)).toEqual({ phase: 'closed' });
    expect(report.mock.calls).toEqual([
      [SESSION, { op: 'shown', appearanceId: 'appearance_1' }],
      [SESSION, { op: 'respond', appearanceId: 'appearance_1', response: 'good' }],
    ]);
  });

  it.each(['turn', 'send', 'close'] as const)('settles the selected answer locally on %s', async (kind) => {
    const store = sessionRatingStore();
    store.select(SESSION, OFFER.appearanceId, 'fine');
    report.mockRejectedValue(new Error('network unavailable'));
    if (kind === 'turn') store.observeTurn(SESSION, 't2', true);
    else if (kind === 'send') promptStore().inFlightBySession[SESSION] = true;
    else store.endSession(SESSION);
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.viewOf(SESSION)).toEqual({ phase: 'closed' });
    expect(report.mock.calls).toEqual([
      [SESSION, { op: 'shown', appearanceId: 'appearance_1' }],
      [SESSION, { op: 'respond', appearanceId: 'appearance_1', response: 'fine' }],
    ]);
  });

  it('reports abandonment once, but not for a reset or stale evaluation', async () => {
    const store = sessionRatingStore();
    store.observeTurn(SESSION, 't2', true);
    store.endSession(SESSION);
    store.$reset();
    await vi.advanceTimersByTimeAsync(5000);
    expect(report.mock.calls).toEqual([
      [SESSION, { op: 'shown', appearanceId: 'appearance_1' }],
      [SESSION, { op: 'abandon', appearanceId: 'appearance_1' }],
    ]);
  });

  it('does not restore a rating or report an unfinished answer after reset', async () => {
    const store = sessionRatingStore();
    store.select(SESSION, OFFER.appearanceId, 'fine');
    store.$reset();
    store.enable();
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.viewOf(SESSION)).toEqual({ phase: 'closed' });
    expect(report.mock.calls).toEqual([[SESSION, { op: 'shown', appearanceId: 'appearance_1' }]]);
  });
});
