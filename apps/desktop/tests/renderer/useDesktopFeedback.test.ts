import { effectScope, shallowRef } from 'vue';
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';
import { dismissToastByKey, onToast, type ToastEvent } from '@moonshot-ai/app-client/client';
import { FEEDBACK_FORM_STALE_MS, useDesktopFeedback, type FeedbackForm, type TurnFeedbackTarget } from '../../src/renderer/composables/useDesktopFeedback';
import { i18n } from '../../src/renderer/i18n';

const { api, getClientConfig } = vi.hoisted(() => ({
  api: {
    createFeedback: vi.fn(), updateFeedback: vi.fn(), uploadFeedbackSession: vi.fn(), uploadFeedbackAttachment: vi.fn(), getUserInfo: vi.fn(),
  },
  getClientConfig: vi.fn(),
}));
vi.mock('../../src/renderer/api', () => ({ getKimiWebApi: () => api }));
vi.mock('@moonshot-ai/app-client/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/app-client/client')>();
  return {
    ...actual,
    getDeviceApi: (hostId?: string) => ({
      getClientConfig: (name: string) => getClientConfig(hostId, name),
    }),
  };
});

let scope = effectScope();
const events: ToastEvent[] = [];
const shown = () => events.filter(event => event.type === 'show');
let unsubscribe: () => void;
beforeEach(() => {
  scope = effectScope();
  vi.resetAllMocks();
  i18n.global.locale.value = 'en';
  events.length = 0;
  unsubscribe = onToast(event => events.push(event));
  let nextId = 0;
  api.createFeedback.mockImplementation(async () => ({ feedback_id: ++nextId }));
  api.uploadFeedbackSession.mockImplementation((_id: number, _session: string, signal: AbortSignal) =>
    new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Upload cancelled', 'AbortError')), { once: true })));
});
afterEach(() => {
  scope.stop();
  unsubscribe();
});

function setup(localId: string | null = 'user', initialSignedIn = true) {
  const signedIn = shallowRef(initialSignedIn);
  const hosts = shallowRef<Record<string, { status: 'signedIn' | 'signedOut' }>>({});
  const accountId = shallowRef(localId);
  const userIds: Record<string, string> = { first: 'user', second: 'user' };
  const hostUserId = vi.fn(async (hostId: string) => userIds[hostId]);
  const feedback = scope.run(() => useDesktopFeedback({
    signedIn: () => signedIn.value, accountId: () => accountId.value ?? undefined, openLogin: vi.fn(),
    sessionHost: sessionId => sessionId === 'local' ? undefined : sessionId,
    hostAccounts: () => hosts.value, hostUserId, openHostLogin: vi.fn(),
  }))!;
  return { signedIn, hosts, userIds, hostUserId, feedback, accountId };
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
    await vi.waitFor(() => expect(shown()).toHaveLength(2));
    expect(api.uploadFeedbackAttachment).toHaveBeenCalledOnce();
    expect(api.uploadFeedbackSession).not.toHaveBeenCalled();
    expect(shown().map(event => event.options)).toMatchObject([
      { variant: 'success', title: 'Feedback submitted · ID 1', copyLink: { label: 'Copy ID', copiedLabel: 'Copied', url: '1' } },
      { variant: 'danger', title: 'Couldn’t submit conversation history', actions: [{ label: 'Retry submission' }] },
    ]);
    userIds['first'] = 'user';
    void shown()[1]?.options?.actions?.[0]?.onClick({ dismiss: vi.fn() });
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
    await vi.waitFor(() => expect(shown()).toHaveLength(2));
    expect(api.uploadFeedbackSession).not.toHaveBeenCalled();
    expect(shown()[1]?.options).toMatchObject({
      variant: 'danger', title: 'Couldn’t submit example.png and conversation history', actions: [{ label: 'Retry submission' }],
    });
    api.getUserInfo.mockResolvedValue({ kind: 'ok', userInfo: { userId: 'user' } });
    void shown()[1]?.options?.actions?.[0]?.onClick({ dismiss: vi.fn() });
    await vi.waitFor(() => expect(api.uploadFeedbackSession).toHaveBeenCalledExactlyOnceWith(1, 'first', expect.any(AbortSignal), { hostId: 'first' }));
    expect(api.uploadFeedbackAttachment).toHaveBeenCalledTimes(2);
    expect(api.createFeedback).toHaveBeenCalledOnce();
  });

  it('keeps a dismissed retry closed and removes the original receipt on account switch', async () => {
    const { feedback, accountId } = setup();
    let finishUpload!: () => void;
    api.uploadFeedbackAttachment.mockRejectedValueOnce(new Error('Offline')).mockImplementationOnce(
      () => new Promise<void>(resolve => { finishUpload = resolve; }),
    );
    const file = new File(['image'], 'example.png', { type: 'image/png' });
    await feedback.submitGlobal({ kind: 'global', source: 'sidebar', category: 'bug', content: 'Example' }, [{ kind: 'media', file }]);
    await vi.waitFor(() => expect(shown()).toHaveLength(2));
    const [receipt, failure] = shown();
    const retry = failure?.options?.actions?.[0];
    expect(retry?.label).toBe('Retry submission');
    const pending = retry?.onClick({ dismiss: vi.fn() });
    await retry?.onClick({ dismiss: vi.fn() });
    expect(api.uploadFeedbackAttachment).toHaveBeenCalledTimes(2);
    const progress = shown()[2];
    expect(progress?.options).toMatchObject({ layout: 'bar', title: 'Submitting…', running: true, duration: 0 });
    assert.isDefined(progress?.key);
    dismissToastByKey(progress.key);
    finishUpload();
    await pending;
    expect(shown()).toHaveLength(3);
    expect(events).not.toContainEqual({ type: 'dismiss', key: receipt?.key });
    accountId.value = 'other-user';
    expect(events).toContainEqual({ type: 'dismiss', key: receipt?.key });
  });

  it('retries only the remaining attachments and announces completion for the saved feedback', async () => {
    const { feedback } = setup();
    const offline = new Error('Offline');
    api.uploadFeedbackAttachment.mockRejectedValueOnce(offline).mockRejectedValueOnce(offline)
      .mockResolvedValueOnce({ upload_id: 1 }).mockRejectedValueOnce(offline).mockResolvedValueOnce({ upload_id: 2 });
    const first = new File(['image'], 'first.png', { type: 'image/png' });
    const second = new File(['image'], 'second.png', { type: 'image/png' });
    await feedback.submitGlobal({ kind: 'global', source: 'sidebar', category: 'other', content: 'Example' }, [
      { kind: 'media', file: first }, { kind: 'media', file: second },
    ]);
    await vi.waitFor(() => expect(shown()).toHaveLength(2));
    expect(shown()[1]?.options?.title).toBe('Couldn’t submit first.png and second.png');
    await shown()[1]?.options?.actions?.[0]?.onClick({ dismiss: vi.fn() });
    expect(shown()[3]?.options?.title).toBe('Couldn’t submit second.png');
    await shown()[3]?.options?.actions?.[0]?.onClick({ dismiss: vi.fn() });
    expect(shown()[5]?.options).toMatchObject({ variant: 'success', title: 'Submitted second.png' });
    expect(api.uploadFeedbackAttachment).toHaveBeenCalledTimes(5);
    expect(api.uploadFeedbackAttachment).toHaveBeenLastCalledWith(1, { kind: 'media', file: second, fileName: second.name }, expect.any(AbortSignal));
    expect(api.createFeedback).toHaveBeenCalledOnce();
  });
});

function formConfig(id: string): FeedbackForm {
  return {
    version: 1,
    reply_reasons: {
      negative: [{ id, label: { en: `Reason ${id}`, zh: `原因 ${id}` } }],
      positive: [{ id: 'helpful', label: { en: 'Helpful', zh: '有帮助' } }],
    },
    learn_more_url: { en: `https://example.com/${id}/en`, zh: `https://example.com/${id}/zh` },
  };
}

describe('feedback form caching by host', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('deduplicates in-flight prefetch and caches parsed forms per host within the stale window', async () => {
    vi.useFakeTimers();
    const { feedback } = setup();
    let resolveFirst!: (value: unknown) => void;
    const localForm = formConfig('local');
    const firstForm = formConfig('first');
    const secondForm = formConfig('second');
    getClientConfig.mockImplementation((hostId?: string) => {
      if (hostId === 'first') return new Promise(resolve => { resolveFirst = resolve; });
      if (hostId === 'second') return Promise.resolve(secondForm);
      return Promise.resolve(localForm);
    });

    feedback.prefetchForm('first');
    const joined = feedback.loadForm('first');
    feedback.prefetchForm('first');
    expect(getClientConfig).toHaveBeenCalledTimes(1);
    expect(getClientConfig).toHaveBeenCalledWith('first', 'feedback_form');
    expect(feedback.peekForm('first')).toBeUndefined();

    resolveFirst(firstForm);
    await expect(joined).resolves.toEqual(firstForm);
    expect(feedback.peekForm('first')).toEqual(firstForm);
    expect(feedback.peekForm('local')).toBeUndefined();

    await expect(feedback.loadForm('first')).resolves.toEqual(firstForm);
    feedback.prefetchForm('first');
    expect(getClientConfig).toHaveBeenCalledTimes(1);

    await expect(feedback.loadForm('local')).resolves.toEqual(localForm);
    await expect(feedback.loadForm()).resolves.toEqual(localForm);
    await expect(feedback.loadForm('second')).resolves.toEqual(secondForm);
    expect(feedback.peekForm('local')).toEqual(localForm);
    expect(feedback.peekForm('first')).toEqual(firstForm);
    expect(feedback.peekForm('second')).toEqual(secondForm);
    expect(getClientConfig).toHaveBeenCalledTimes(3);
  });

  it('does not cache failed or invalid form responses and retries on the next load', async () => {
    const { feedback } = setup();
    const valid = formConfig('recovered');
    getClientConfig
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValueOnce({ version: 99 })
      .mockResolvedValueOnce(valid);

    await expect(feedback.loadForm('first')).resolves.toBeNull();
    expect(feedback.peekForm('first')).toBeUndefined();
    await expect(feedback.loadForm('first')).resolves.toBeNull();
    expect(feedback.peekForm('first')).toBeUndefined();
    await expect(feedback.loadForm('first')).resolves.toEqual(valid);
    expect(feedback.peekForm('first')).toEqual(valid);
    expect(getClientConfig).toHaveBeenCalledTimes(3);
  });

  it('serves stale cached forms immediately while revalidating in the background after 6 hours', async () => {
    vi.useFakeTimers();
    const { feedback } = setup();
    const initial = formConfig('v1');
    const updated = formConfig('v2');
    let rejectRefresh!: (error: Error) => void;
    let resolveRefresh!: (value: unknown) => void;
    getClientConfig
      .mockResolvedValueOnce(initial)
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRefresh = reject; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveRefresh = resolve; }));

    expect(FEEDBACK_FORM_STALE_MS).toBe(6 * 60 * 60 * 1000);
    await expect(feedback.loadForm('first')).resolves.toEqual(initial);
    vi.advanceTimersByTime(FEEDBACK_FORM_STALE_MS - 1);
    await expect(feedback.loadForm('first')).resolves.toEqual(initial);
    expect(getClientConfig).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(feedback.peekForm('first')).toEqual(initial);
    await expect(feedback.loadForm('first')).resolves.toEqual(initial);
    feedback.prefetchForm('first');
    await expect(feedback.loadForm('first')).resolves.toEqual(initial);
    expect(getClientConfig).toHaveBeenCalledTimes(2);

    rejectRefresh(new Error('Offline'));
    await Promise.resolve();
    await Promise.resolve();
    expect(feedback.peekForm('first')).toEqual(initial);

    await expect(feedback.loadForm('first')).resolves.toEqual(initial);
    expect(getClientConfig).toHaveBeenCalledTimes(3);

    resolveRefresh(updated);
    await Promise.resolve();
    await Promise.resolve();
    expect(feedback.peekForm('first')).toEqual(updated);
    await expect(feedback.loadForm('first')).resolves.toEqual(updated);
    expect(getClientConfig).toHaveBeenCalledTimes(3);
  });

  it('clears a host form cache on sign-out and ignores in-flight responses from before the clear', async () => {
    const { feedback, hosts, accountId } = setup();
    let resolveStale!: (value: unknown) => void;
    const stale = formConfig('stale');
    const fresh = formConfig('fresh');
    const localForm = formConfig('local');
    getClientConfig
      .mockImplementationOnce(() => new Promise(resolve => { resolveStale = resolve; }))
      .mockResolvedValueOnce(localForm)
      .mockResolvedValueOnce(fresh);

    const pending = feedback.loadForm('first');
    await expect(feedback.loadForm('local')).resolves.toEqual(localForm);
    hosts.value = { first: { status: 'signedOut' } };
    resolveStale(stale);
    await pending;

    expect(feedback.peekForm('first')).toBeUndefined();
    expect(feedback.peekForm('local')).toEqual(localForm);

    await expect(feedback.loadForm('first')).resolves.toEqual(fresh);
    expect(feedback.peekForm('first')).toEqual(fresh);

    accountId.value = 'other-user';
    expect(feedback.peekForm('local')).toBeUndefined();
    expect(feedback.peekForm('first')).toEqual(fresh);
  });

  it('catches synchronous device API failures without poisoning the cache', async () => {
    const { feedback } = setup();
    const recovered = formConfig('recovered');
    getClientConfig
      .mockImplementationOnce(() => { throw new Error('SSH host is unavailable'); })
      .mockResolvedValueOnce(recovered);

    await expect(feedback.loadForm('first')).resolves.toBeNull();
    expect(feedback.peekForm('first')).toBeUndefined();
    await expect(feedback.loadForm('first')).resolves.toEqual(recovered);
    expect(feedback.peekForm('first')).toEqual(recovered);
  });

  it('skips prefetch while signed out and clears any pre-login local form cache on sign-in', async () => {
    const { feedback, signedIn, hosts } = setup(null, false);
    const preLogin = formConfig('default-region');
    const postLogin = formConfig('signed-in-region');
    getClientConfig.mockResolvedValueOnce(preLogin).mockResolvedValueOnce(postLogin);

    feedback.prefetchForm('local');
    hosts.value = { first: { status: 'signedOut' } };
    feedback.prefetchForm('first');
    expect(getClientConfig).not.toHaveBeenCalled();

    await expect(feedback.loadForm('local')).resolves.toEqual(preLogin);
    expect(feedback.peekForm('local')).toEqual(preLogin);

    signedIn.value = true;
    expect(feedback.peekForm('local')).toBeUndefined();
    await expect(feedback.loadForm('local')).resolves.toEqual(postLogin);
    expect(feedback.peekForm('local')).toEqual(postLogin);
  });
});
