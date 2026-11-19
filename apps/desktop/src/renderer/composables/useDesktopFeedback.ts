import { onScopeDispose, shallowReactive, shallowRef, watch, type InjectionKey } from 'vue';
import type { ChatTurn } from '@moonshot-ai/app-core/client';
import { isDaemonApiError, KIMI_AUTH_REJECTED_CODE, KIMI_AUTH_REQUIRED_CODE, type CreateFeedbackInput } from '@moonshot-ai/app-core/api';
import { isDesktop } from '@moonshot-ai/app-core/lib';
import { getKimiWebApi } from '../api';
import { showFeedbackError, showFeedbackReceipt, type FeedbackAttachment } from '../lib/feedbackReceipt';

export type { FeedbackAttachment } from '../lib/feedbackReceipt';

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
  sessionHost: (sessionId: string) => string | undefined;
  hostAccounts: () => Readonly<Record<string, { status: 'signedIn' | 'signedOut' } | undefined>>;
  hostUserId: (hostId: string) => Promise<string | undefined>;
  openHostLogin: (hostId: string) => void;
}) {
  const activePopover = shallowRef<string>();
  const accounts = shallowReactive(new Map<string | undefined, FeedbackAccount>());
  const accountEpoch = shallowRef(0);
  let activeAccountId = deps.accountId();

  function accountFor(hostId?: string): FeedbackAccount {
    let account = accounts.get(hostId);
    if (account === undefined) {
      account = {
        controller: new AbortController(), turnStates: shallowReactive(new Map()), thanksTimers: new Map(),
      };
      accounts.set(hostId, account);
    }
    return account;
  }

  function clearAccountState(hostId?: string): void {
    const account = accounts.get(hostId);
    if (hostId === undefined) accountEpoch.value += 1;
    if (account === undefined) return;
    account.controller.abort();
    if (activePopover.value !== undefined && account.turnStates.has(activePopover.value)) closePopover();
    for (const timer of account.thanksTimers.values()) clearTimeout(timer);
    accounts.delete(hostId);
  }

  async function ownsExistingRating(account: FeedbackAccount, hostId: string): Promise<boolean> {
    const current = deps.hostUserId(hostId).catch(() => undefined);
    const [initialId, currentId] = await Promise.all([account.identity, current]);
    if (account.controller.signal.aborted) return false;
    if (initialId !== undefined && currentId !== undefined && initialId !== currentId) {
      clearAccountState(hostId);
      return false;
    }
    if (currentId !== undefined) account.identity = current;
    return true;
  }

  watch([deps.signedIn, deps.accountId], ([signedIn, accountId]) => {
    if (!signedIn) {
      activeAccountId = undefined;
      clearAccountState();
    } else if (accountId !== undefined) {
      if (activeAccountId !== undefined && activeAccountId !== accountId) clearAccountState();
      activeAccountId = accountId;
    }
  }, { flush: 'sync' });
  watch(deps.hostAccounts, hosts => {
    for (const hostId of accounts.keys()) {
      if (hostId !== undefined && hosts[hostId]?.status === 'signedOut') clearAccountState(hostId);
    }
  }, { flush: 'sync' });
  onScopeDispose(() => {
    for (const hostId of accounts.keys()) clearAccountState(hostId);
  });

  function state(target: TurnFeedbackTarget | undefined): TurnFeedback | undefined {
    return target === undefined ? undefined : accounts.get(deps.sessionHost(target.sessionId))?.turnStates.get(turnFeedbackKey(target));
  }

  function isPopoverOpen(target: TurnFeedbackTarget | undefined): boolean {
    return target !== undefined && activePopover.value === turnFeedbackKey(target);
  }

  function closePopover(target?: TurnFeedbackTarget): void {
    if (target === undefined || isPopoverOpen(target)) activePopover.value = undefined;
  }

  function requireLogin(sessionId?: string): boolean {
    const host = sessionId === undefined ? undefined : deps.sessionHost(sessionId);
    if (host === undefined ? deps.signedIn() : deps.hostAccounts()[host]?.status !== 'signedOut') return true;
    closePopover();
    if (host === undefined) deps.openLogin();
    else deps.openHostLogin(host);
    return false;
  }

  function handleLoginError(error: unknown, sessionId?: string): boolean {
    if (!isDaemonApiError(error) || error.code !== KIMI_AUTH_REQUIRED_CODE) return false;
    const host = sessionId === undefined ? undefined : deps.sessionHost(sessionId);
    closePopover();
    if (host === undefined) deps.openLogin();
    else deps.openHostLogin(host);
    return true;
  }

  async function submitGlobal(input: Extract<CreateFeedbackInput, { kind: 'global' }>, attachments: FeedbackAttachment[]): Promise<number | undefined> {
    const { signal } = accountFor().controller;
    const session = attachments.find(item => item.kind === 'session');
    const host = session === undefined ? undefined : deps.sessionHost(session.sessionId);
    const submitter = deps.accountId();
    try {
      const { feedback_id: id } = await getKimiWebApi().createFeedback({
        ...input,
        client: isDesktop ? 'desktop' : 'web',
        upload_session: attachments.some((item) => item.kind === 'session'),
        upload_logs: attachments.some((item) => item.kind === 'diagnostics'),
      });
      if (signal.aborted) return;
      const authorizeSession = session === undefined || host === undefined ? undefined : async () => {
        if (!requireLogin(session.sessionId)) return;
        const hostSignal = accountFor(host).controller.signal;
        const userId = submitter ?? deps.accountId() ?? await getKimiWebApi().getUserInfo().then(info =>
          info.kind === 'ok' ? info.userInfo.userId : undefined);
        if (userId !== undefined && userId === await deps.hostUserId(host)) return hostSignal;
      };
      showFeedbackReceipt(id, attachments, signal, handleLoginError, { hostId: host, authorizeSession });
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
    const host = deps.sessionHost(target.sessionId);
    const account = accountFor(host);
    if (host !== undefined) account.identity ??= deps.hostUserId(host).catch(() => undefined);
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
        if (host !== undefined && !await ownsExistingRating(account, host)) return;
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
    const host = deps.sessionHost(target.sessionId);
    const account = accountFor(host);
    const { signal } = account.controller;
    const { turnStates } = account;
    const current = turnStates.get(key);
    if (current?.kind !== 'recorded' || current.record.rating !== 'down') return;
    const { record } = current;
    turnStates.set(key, { kind: 'updating', record });
    try {
      if (host !== undefined && !await ownsExistingRating(account, host)) return;
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

  return { accountEpoch, clearHostAccount: (hostId: string) => clearAccountState(hostId), state, isPopoverOpen, closePopover, requireLogin, submitGlobal, chooseRating, submitDetails };
}

export const DesktopFeedbackKey: InjectionKey<ReturnType<typeof useDesktopFeedback>> = Symbol('desktop-feedback');
