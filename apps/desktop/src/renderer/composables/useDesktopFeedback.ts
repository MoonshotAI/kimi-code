import { onScopeDispose, shallowReactive, shallowRef, watch, type InjectionKey } from 'vue';
import { getDeviceApi } from '@moonshot-ai/app-client/client';
import type { ChatTurn } from '@moonshot-ai/app-core/client';
import { isDaemonApiError, KIMI_AUTH_REJECTED_CODE, KIMI_AUTH_REQUIRED_CODE, type CreateFeedbackInput } from '@moonshot-ai/app-core/api';
import { isDesktop } from '@moonshot-ai/app-core/lib';
import { FEEDBACK_FORM_CONFIG_NAME, feedbackFormSchema, type FeedbackForm } from '@moonshot-ai/kap-server/protocol/feedback-reasons';
import { getKimiWebApi } from '../api';
import { showFeedbackError, showFeedbackReceipt, type FeedbackAttachment } from '../lib/feedbackReceipt';

export type { FeedbackAttachment } from '../lib/feedbackReceipt';
export type { FeedbackForm };

export interface GlobalFeedbackTarget {
  source: 'sidebar' | 'command';
  sessionId?: string;
}

export interface TurnFeedbackTarget {
  sessionId: string;
  turnId: string;
  replyId: string;
}

export type FeedbackRating = 'up' | 'down';

interface RecordedRating {
  rating: FeedbackRating;
  feedbackId: number;
  status?: 'thanks';
  sessionUpload?: AbortController;
}

type TurnFeedback =
  | { kind: 'saving'; rating: FeedbackRating }
  | { kind: 'recorded'; record: RecordedRating }
  | { kind: 'updating'; record: RecordedRating };

interface FeedbackAccount {
  controller: AbortController;
  turnStates: Map<string, TurnFeedback>;
  thanksTimers: Map<string, ReturnType<typeof setTimeout>>;
  identity?: Promise<string | undefined>;
}

export const FEEDBACK_DESCRIPTION_LIMIT = 2000;
export const FEEDBACK_FORM_STALE_MS = 6 * 60 * 60 * 1000;

interface FeedbackFormCacheEntry {
  value?: FeedbackForm;
  fetchedAt?: number;
  inflight?: Promise<FeedbackForm | null>;
}

export function feedbackAccessFailureKey(error: unknown): 'feedback.accessDenied' | undefined {
  if (isDaemonApiError(error) && error.code === KIMI_AUTH_REJECTED_CODE) return 'feedback.accessDenied';
}

export function feedbackTurnTarget(sessionId: string | undefined, turn: ChatTurn | undefined): TurnFeedbackTarget | undefined {
  if (sessionId === undefined || turn?.sourceTurnId === undefined || turn.sourceReplyId === undefined) return;
  return { sessionId, turnId: turn.sourceTurnId, replyId: turn.sourceReplyId };
}

function turnFeedbackKey(target: TurnFeedbackTarget): string {
  return JSON.stringify([target.sessionId, target.turnId, target.replyId]);
}

export function useDesktopFeedback(deps: {
  signedIn: () => boolean;
  accountId: () => string | undefined;
  openLogin: () => void;
  sessionDevice: (sessionId: string) => string | undefined;
  deviceAccounts: () => Readonly<Record<string, { status: 'signedIn' | 'signedOut' } | undefined>>;
  deviceUserId: (deviceId: string) => Promise<string | undefined>;
  openDeviceLogin: (deviceId: string) => void;
}) {
  const activePopover = shallowRef<string>();
  const accounts = shallowReactive(new Map<string | undefined, FeedbackAccount>());
  const formCache = new Map<string | undefined, FeedbackFormCacheEntry>();
  const accountEpoch = shallowRef(0);
  let activeAccountId = deps.accountId();

  function accountFor(deviceId?: string): FeedbackAccount {
    let account = accounts.get(deviceId);
    if (account === undefined) {
      account = {
        controller: new AbortController(), turnStates: shallowReactive(new Map()), thanksTimers: new Map(),
      };
      accounts.set(deviceId, account);
    }
    return account;
  }

  function clearAccountState(deviceId?: string): void {
    formCache.delete(deviceId);
    const account = accounts.get(deviceId);
    if (deviceId === undefined) accountEpoch.value += 1;
    if (account === undefined) return;
    account.controller.abort();
    if (activePopover.value !== undefined && account.turnStates.has(activePopover.value)) closePopover();
    for (const timer of account.thanksTimers.values()) clearTimeout(timer);
    accounts.delete(deviceId);
  }

  async function ownsExistingRating(account: FeedbackAccount, deviceId: string): Promise<boolean> {
    const current = deps.deviceUserId(deviceId).catch(() => undefined);
    const [initialId, currentId] = await Promise.all([account.identity, current]);
    if (account.controller.signal.aborted) return false;
    if (initialId !== undefined && currentId !== undefined && initialId !== currentId) {
      clearAccountState(deviceId);
      return false;
    }
    if (currentId !== undefined) account.identity = current;
    return true;
  }

  watch([deps.signedIn, deps.accountId], ([signedIn, accountId], [wasSignedIn]) => {
    if (!signedIn) {
      activeAccountId = undefined;
      clearAccountState();
    } else {
      if (!wasSignedIn) formCache.delete(undefined);
      if (accountId !== undefined) {
        if (activeAccountId !== undefined && activeAccountId !== accountId) clearAccountState();
        activeAccountId = accountId;
      }
    }
  }, { flush: 'sync' });
  watch(deps.deviceAccounts, devices => {
    for (const deviceId of new Set([...accounts.keys(), ...formCache.keys()])) {
      if (deviceId !== undefined && devices[deviceId]?.status === 'signedOut') clearAccountState(deviceId);
    }
  }, { flush: 'sync' });
  onScopeDispose(() => {
    for (const deviceId of accounts.keys()) clearAccountState(deviceId);
    formCache.clear();
  });

  function state(target: TurnFeedbackTarget | undefined): TurnFeedback | undefined {
    return target === undefined ? undefined : accounts.get(deps.sessionDevice(target.sessionId))?.turnStates.get(turnFeedbackKey(target));
  }

  function isPopoverOpen(target: TurnFeedbackTarget | undefined): boolean {
    return target !== undefined && activePopover.value === turnFeedbackKey(target);
  }

  function formDevice(sessionId?: string): string | undefined {
    return sessionId === undefined ? undefined : deps.sessionDevice(sessionId);
  }

  function peekForm(sessionId?: string): FeedbackForm | undefined {
    return formCache.get(formDevice(sessionId))?.value;
  }

  function revalidateForm(device: string | undefined, existing?: FeedbackFormCacheEntry): Promise<FeedbackForm | null> {
    if (existing?.inflight !== undefined) return existing.inflight;
    let rawConfig: Promise<unknown>;
    try {
      rawConfig = getDeviceApi(device).getClientConfig(FEEDBACK_FORM_CONFIG_NAME);
    } catch {
      return Promise.resolve(null);
    }
    const entry: FeedbackFormCacheEntry = existing ?? {};
    formCache.set(device, entry);
    const request = rawConfig
      .then(config => feedbackFormSchema.safeParse(config).data ?? null, () => null)
      .then(parsed => {
        if (formCache.get(device) === entry && entry.inflight === request) {
          entry.inflight = undefined;
          if (parsed !== null) {
            entry.value = parsed;
            entry.fetchedAt = Date.now();
          } else if (entry.value === undefined) {
            formCache.delete(device);
          }
        }
        return parsed;
      });
    entry.inflight = request;
    return request;
  }

  function loadForm(sessionId?: string): Promise<FeedbackForm | null> {
    const device = formDevice(sessionId);
    const existing = formCache.get(device);
    if (existing?.value !== undefined) {
      if (existing.fetchedAt === undefined || Date.now() - existing.fetchedAt >= FEEDBACK_FORM_STALE_MS) {
        void revalidateForm(device, existing);
      }
      return Promise.resolve(existing.value);
    }
    return revalidateForm(device, existing);
  }

  function prefetchForm(sessionId?: string): void {
    const device = formDevice(sessionId);
    if (device === undefined ? !deps.signedIn() : deps.deviceAccounts()[device]?.status === 'signedOut') return;
    void loadForm(sessionId);
  }

  function closePopover(target?: TurnFeedbackTarget): void {
    if (target === undefined || isPopoverOpen(target)) activePopover.value = undefined;
  }

  function requireLogin(sessionId?: string): boolean {
    const device = sessionId === undefined ? undefined : deps.sessionDevice(sessionId);
    if (device === undefined ? deps.signedIn() : deps.deviceAccounts()[device]?.status !== 'signedOut') return true;
    closePopover();
    if (device === undefined) deps.openLogin();
    else deps.openDeviceLogin(device);
    return false;
  }

  function handleLoginError(error: unknown, sessionId?: string): boolean {
    if (!isDaemonApiError(error) || error.code !== KIMI_AUTH_REQUIRED_CODE) return false;
    const device = sessionId === undefined ? undefined : deps.sessionDevice(sessionId);
    closePopover();
    if (device === undefined) deps.openLogin();
    else deps.openDeviceLogin(device);
    return true;
  }

  async function submitGlobal(input: Extract<CreateFeedbackInput, { kind: 'global' }>, attachments: FeedbackAttachment[]): Promise<number | undefined> {
    const { signal } = accountFor().controller;
    const session = attachments.find(item => item.kind === 'session');
    const device = session === undefined ? undefined : deps.sessionDevice(session.sessionId);
    const submitter = deps.accountId();
    try {
      const { feedback_id: id } = await getKimiWebApi().createFeedback({
        ...input,
        client: isDesktop ? 'desktop' : 'web',
        upload_session: attachments.some((item) => item.kind === 'session'),
        upload_logs: attachments.some((item) => item.kind === 'diagnostics'),
      });
      if (signal.aborted) return;
      const authorizeSession = session === undefined || device === undefined ? undefined : async () => {
        if (!requireLogin(session.sessionId)) return;
        const deviceSignal = accountFor(device).controller.signal;
        const userId = submitter ?? deps.accountId() ?? await getKimiWebApi().getUserInfo().then(info =>
          info.kind === 'ok' ? info.userInfo.userId : undefined);
        if (userId !== undefined && userId === await deps.deviceUserId(device)) return deviceSignal;
      };
      showFeedbackReceipt(id, attachments, signal, handleLoginError, { deviceId: device, authorizeSession });
      return id;
    } catch (error) {
      if (signal.aborted) return;
      handleLoginError(error);
      throw error;
    }
  }

  async function chooseRating(target: TurnFeedbackTarget, rating: FeedbackRating): Promise<void> {
    if (!requireLogin(target.sessionId)) return;
    const key = turnFeedbackKey(target);
    const device = deps.sessionDevice(target.sessionId);
    const account = accountFor(device);
    if (device !== undefined) account.identity ??= deps.deviceUserId(device).catch(() => undefined);
    const { signal } = account.controller;
    const { turnStates, thanksTimers } = account;
    const current = turnStates.get(key);
    if (current !== undefined && current.kind !== 'recorded') return;
    let previous = current?.record;
    const togglingOff = previous?.rating === rating;
    const timer = thanksTimers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      thanksTimers.delete(key);
      if (previous?.status !== undefined) previous = { ...previous, status: undefined };
    }
    if (rating === 'down' && !togglingOff) activePopover.value = key;
    else closePopover();
    turnStates.set(key, { kind: 'saving', rating: previous?.rating ?? rating });
    try {
      const api = getKimiWebApi();
      if (previous !== undefined) {
        if (device !== undefined && !await ownsExistingRating(account, device)) return;
        await api.updateFeedback(previous.feedbackId, { kind: 'cancel' }, target.sessionId);
        previous.sessionUpload?.abort();
        previous = undefined;
        if (signal.aborted) return;
      }
      if (togglingOff) {
        turnStates.delete(key);
        return;
      }
      turnStates.set(key, { kind: 'saving', rating });
      const { feedback_id: feedbackId } = await api.createFeedback({
        kind: 'turn', session_id: target.sessionId, turn_id: target.turnId, reply_id: target.replyId, rating,
        client: isDesktop ? 'desktop' : 'web',
      });
      if (signal.aborted) return;
      turnStates.set(key, {
        kind: 'recorded',
        record: { rating, feedbackId, status: rating === 'up' ? 'thanks' : undefined },
      });
      if (rating === 'up') expireStatus(account, key, feedbackId);
    } catch (error) {
      if (signal.aborted) return;
      if (previous === undefined) turnStates.delete(key);
      else turnStates.set(key, { kind: 'recorded', record: previous });
      closePopover(target);
      if (!handleLoginError(error, target.sessionId)) {
        showFeedbackError(feedbackAccessFailureKey(error) ?? (previous === undefined ? 'feedback.rateFailed' : 'feedback.undoFailed'), signal);
      }
    }
  }

  async function submitDetails(
    target: TurnFeedbackTarget,
    details: { reasons: string[]; content: string; includeSession: boolean },
  ): Promise<string | undefined> {
    if (!requireLogin(target.sessionId)) return;
    const key = turnFeedbackKey(target);
    const device = deps.sessionDevice(target.sessionId);
    const account = accountFor(device);
    const { signal } = account.controller;
    const { turnStates } = account;
    const current = turnStates.get(key);
    if (current?.kind !== 'recorded' || current.record.rating !== 'down') return;
    const { record } = current;
    turnStates.set(key, { kind: 'updating', record });
    try {
      if (device !== undefined && !await ownsExistingRating(account, device)) return;
      await getKimiWebApi().updateFeedback(record.feedbackId, {
        kind: 'details',
        reasons: details.reasons,
        content: details.content.trim() || undefined,
        upload_session: details.includeSession,
      }, target.sessionId);
    } catch (error) {
      if (signal.aborted) return;
      turnStates.set(key, current);
      if (handleLoginError(error, target.sessionId)) return;
      const failure = feedbackAccessFailureKey(error) ?? 'feedback.submitFailed';
      showFeedbackError(failure, signal);
      return failure;
    }
    if (signal.aborted) return;
    const sessionUpload = details.includeSession ? new AbortController() : undefined;
    turnStates.set(key, { kind: 'recorded', record: { ...record, status: 'thanks', sessionUpload } });
    closePopover(target);
    expireStatus(account, key, record.feedbackId);
    const attachments: FeedbackAttachment[] = sessionUpload ? [{ kind: 'session', sessionId: target.sessionId }] : [];
    const uploadSignal = sessionUpload ? AbortSignal.any([signal, sessionUpload.signal]) : signal;
    showFeedbackReceipt(record.feedbackId, attachments, uploadSignal, handleLoginError);
  }

  function expireStatus({ turnStates, thanksTimers }: FeedbackAccount, key: string, feedbackId: number): void {
    clearTimeout(thanksTimers.get(key));
    thanksTimers.set(key, setTimeout(() => {
      const saved = turnStates.get(key);
      if (saved?.kind === 'recorded' && saved.record.feedbackId === feedbackId) {
        turnStates.set(key, { kind: 'recorded', record: { ...saved.record, status: undefined } });
      }
      thanksTimers.delete(key);
    }, 2000));
  }

  return { accountEpoch, clearDeviceAccount: (deviceId: string) => clearAccountState(deviceId), state, isPopoverOpen, closePopover, peekForm, prefetchForm, loadForm, requireLogin, submitGlobal, chooseRating, submitDetails };
}

export const DesktopFeedbackKey: InjectionKey<ReturnType<typeof useDesktopFeedback>> = Symbol('desktop-feedback');
