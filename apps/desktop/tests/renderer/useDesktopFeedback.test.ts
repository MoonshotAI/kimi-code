import { effectScope, shallowRef, type VNode } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDesktopFeedback, type TurnFeedbackTarget } from '../../src/renderer/composables/useDesktopFeedback';

const { api, toast } = vi.hoisted(() => ({
  api: {
    createFeedback: vi.fn(), updateFeedback: vi.fn(), uploadFeedbackSession: vi.fn(), uploadFeedbackAttachment: vi.fn(), getUserInfo: vi.fn(),
  },
  toast: vi.fn<(notice: { presentation: (controls: { dismiss: () => void }) => VNode }) => void>(),
}));
vi.mock('../../src/renderer/api', () => ({ getKimiWebApi: () => api }));
vi.mock('@moonshot-ai/app-client/client', () => ({ toast }));
vi.mock('../../src/renderer/components/feedback/FeedbackReceipt.vue', () => ({ default: {} }));

let scope = effectScope();
beforeEach(() => {
  scope = effectScope();
  vi.resetAllMocks();
  let nextId = 0;
  api.createFeedback.mockImplementation(async () => ({ feedback_id: ++nextId }));
  api.uploadFeedbackSession.mockImplementation((_id: number, _session: string, signal: AbortSignal) =>
    new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Upload cancelled', 'AbortError')), { once: true })));
});
afterEach(() => scope.stop());

function setup(localId: string | null = 'user') {
  const hosts = shallowRef<Record<string, { status: 'signedIn' | 'signedOut' }>>({});
  const userIds: Record<string, string> = { first: 'user', second: 'user' };
  const hostUserId = vi.fn(async (hostId: string) => userIds[hostId]);
  const feedback = scope.run(() => useDesktopFeedback({
    signedIn: () => true, accountId: () => localId ?? undefined, openLogin: vi.fn(),
    sessionHost: sessionId => sessionId === 'local' ? undefined : sessionId,
    hostAccounts: () => hosts.value, hostUserId, openHostLogin: vi.fn(),
  }))!;
  return { hosts, userIds, hostUserId, feedback };
}

const target = (sessionId: string): TurnFeedbackTarget => ({ sessionId, turnId: 'turn', replyId: 'reply' });
const details = { reasons: ['incorrect'], content: '', includeSession: true };

describe('feedback account ownership', () => {
  it('clears an SSH account on sign-out while other hosts keep their ratings and uploads', async () => {
    const { feedback, hosts, hostUserId } = setup();
    const local = target('local');
    const first = target('first');
    const second = target('second');
    await feedback.chooseRating(local, 'up');
    for (const reply of [first, second]) {
      await feedback.chooseRating(reply, 'down');
      await feedback.submitDetails(reply, details);
    }
    const [firstUpload, secondUpload] = api.uploadFeedbackSession.mock.calls.map(call => call[2] as AbortSignal);
    const profileCalls = hostUserId.mock.calls.length;
    hosts.value = { first: { status: 'signedIn' }, second: { status: 'signedIn' } };
    expect(feedback.state(first)?.kind).toBe('recorded');
    hosts.value = { ...hosts.value, first: { status: 'signedOut' } };
    expect(hostUserId).toHaveBeenCalledTimes(profileCalls);
    expect(firstUpload?.aborted).toBe(true);
    expect(secondUpload?.aborted).toBe(false);
    expect(feedback.state(first)).toBeUndefined();
    expect(feedback.state(second)?.kind).toBe('recorded');
    expect(feedback.state(local)?.kind).toBe('recorded');
    expect(feedback.accountEpoch.value).toBe(0);
  });

  it('checks the owner before updating an existing remote rating after an account switch', async () => {
    const { feedback, userIds } = setup();
    const reply = target('first');
    await feedback.chooseRating(reply, 'up');
    userIds['first'] = 'other-user';
    await feedback.chooseRating(reply, 'up');
    expect(api.updateFeedback).not.toHaveBeenCalled();
    expect(feedback.state(reply)).toBeUndefined();
    await feedback.chooseRating(reply, 'up');
    expect(feedback.state(reply)).toMatchObject({ record: { feedbackId: 2 } });
  });

  it('ignores a late rating response after its host has signed out', async () => {
    const { feedback, hosts } = setup();
    let finish = () => {};
    api.createFeedback.mockImplementationOnce(() => new Promise(resolve => {
      finish = () => resolve({ feedback_id: 12 });
    }));
    const reply = target('first');
    const pending = feedback.chooseRating(reply, 'down');
    expect(feedback.isPopoverOpen(reply)).toBe(true);
    hosts.value = { first: { status: 'signedOut' } };
    expect(feedback.isPopoverOpen(reply)).toBe(false);
    finish();
    await pending;
    expect(feedback.state(reply)).toBeUndefined();
    expect(api.updateFeedback).not.toHaveBeenCalled();
  });

  it('keeps local media uploading and reports a remote archive belonging to a different account', async () => {
    const { feedback, userIds } = setup();
    userIds['first'] = 'other-user';
    const file = new File(['image'], 'example.png', { type: 'image/png' });
    await feedback.submitGlobal({ kind: 'global', source: 'sidebar', category: 'other', content: 'Example', session_id: 'first' }, [
      { kind: 'media', file }, { kind: 'session', sessionId: 'first' },
    ]);
    await vi.waitFor(() => expect(toast).toHaveBeenCalledTimes(2));
    expect(api.uploadFeedbackAttachment).toHaveBeenCalledOnce();
    expect(api.uploadFeedbackSession).not.toHaveBeenCalled();
    const notice = toast.mock.calls[1]?.[0].presentation({ dismiss: () => {} }).props?.['notice'];
    expect(notice).toMatchObject({ kind: 'upload', failed: [{ kind: 'session', sessionId: 'first' }] });
    userIds['first'] = 'user';
    notice.retry();
    await vi.waitFor(() => expect(api.uploadFeedbackSession).toHaveBeenCalledExactlyOnceWith(1, 'first', expect.any(AbortSignal), { hostId: 'first' }));
    expect(api.uploadFeedbackAttachment).toHaveBeenCalledOnce();
    feedback.clearHostAccount('first');
    expect(api.uploadFeedbackSession.mock.calls[0]?.[2]).toHaveProperty('aborted', true);
    expect(api.uploadFeedbackAttachment.mock.calls[0]?.[2]).toHaveProperty('aborted', false);
  });

  it('reports mixed failures together in submission order and does not send a session with unverified ownership', async () => {
    const { feedback } = setup(null);
    api.uploadFeedbackAttachment.mockRejectedValueOnce(new Error('Offline'));
    api.getUserInfo.mockResolvedValue({ kind: 'error', message: 'Unavailable' });
    const file = new File(['image'], 'example.png', { type: 'image/png' });
    await feedback.submitGlobal({ kind: 'global', source: 'sidebar', category: 'other', content: 'Example', session_id: 'first' }, [
      { kind: 'media', file }, { kind: 'session', sessionId: 'first' },
    ]);
    await vi.waitFor(() => expect(toast).toHaveBeenCalledTimes(2));
    expect(api.uploadFeedbackSession).not.toHaveBeenCalled();
    const notice = toast.mock.calls[1]?.[0].presentation({ dismiss: () => {} }).props?.['notice'];
    expect(notice).toMatchObject({ kind: 'upload', failed: [{ kind: 'media', file }, { kind: 'session', sessionId: 'first' }] });
    api.getUserInfo.mockResolvedValue({ kind: 'ok', userInfo: { userId: 'user' } });
    notice.retry();
    await vi.waitFor(() => expect(api.uploadFeedbackSession).toHaveBeenCalledExactlyOnceWith(1, 'first', expect.any(AbortSignal), { hostId: 'first' }));
    expect(api.uploadFeedbackAttachment).toHaveBeenCalledTimes(2);
    expect(api.createFeedback).toHaveBeenCalledOnce();
  });
});
