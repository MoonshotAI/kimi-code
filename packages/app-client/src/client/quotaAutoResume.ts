import { shallowRef } from 'vue';
import { v4 as randomUUID } from 'uuid';
import { isDaemonApiError, type ManagedQuotaResult, type QuotaEntry } from '@moonshot-ai/app-core/api';
import type { ConversationError } from '@moonshot-ai/app-core/conversation';
import { STORAGE_KEYS, safeGetJson, safeRemove, safeSetJson } from '@moonshot-ai/app-core/lib';
import { stablePromptId } from './promptId';

export const QUOTA_AUTO_RESUME_MAX_WAIT_MS = 24 * 60 * 60 * 1000;
export const QUOTA_AUTO_RESUME_GRACE_MS = 30 * 60 * 1000;
export const QUOTA_AUTO_RESUME_TICK_MS = 60 * 1000;
export const QUOTA_AUTO_RESUME_RESERVATION_LEASE_MS = 2 * QUOTA_AUTO_RESUME_TICK_MS;
export const QUOTA_AUTO_RESUME_MIN_JITTER_MS = 5_000;
export const QUOTA_AUTO_RESUME_JITTER_SPAN_MS = 10_000;
export const QUOTA_AUTO_RESUME_MAX_POLL_MS = 15 * 60 * 1000;
export const QUOTA_AUTO_RESUME_NULL_RESET_COOLDOWN_MS = 60 * 60 * 1000;
export const QUOTA_AUTO_RESUME_RETRY_DELAYS_MS = [30 * 1000, 2 * 60 * 1000, 5 * 60 * 1000] as const;
export const QUOTA_AUTO_RESUME_FALLBACK_DELAYS_MS = [60 * 1000, 5 * 60 * 1000, QUOTA_AUTO_RESUME_MAX_POLL_MS] as const;

const SAME_WINDOW_TOLERANCE_MS = 60 * 1000;
const SCHEDULER_LOCK_NAME = 'kimi-web.quota-auto-resume.fire';
const PROMPT_ID_CONFLICT_CODE = 40927;
const MANAGED_QUOTA_MESSAGE_PATTERN = /usage limit|quota|5-hour|7-day|weekly|monthly|billing cycle/i;

export interface QuotaAutoResumeHost {
  enabled: () => boolean;
  isManagedKimiSession: (sessionId: string) => boolean | Promise<boolean>;
  getUsage: (sessionId: string) => Promise<ManagedQuotaResult>;
  checkSessionReady: (sessionId: string, failedTurnId: string) => Promise<boolean>;
  submitResume: (sessionId: string, input: { turnId: string; resetAt: string | null; promptId: string }) => Promise<void>;
  onGiveUp?: (sessionId: string, error: unknown) => void;
  onReservationAvailable?: () => void;
  withLock?: <T>(fn: () => Promise<T>) => Promise<T>;
  now?: () => number;
  random?: () => number;
}

export interface QuotaAutoResumeReservation {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly failedTurnId: string;
  readonly resetAt: string | null;
  readonly expiresAt: number;
}

interface PendingResume {
  readonly sessionId: string;
  readonly failedTurnId: string;
  readonly promptId: string;
  readonly armedAt: number;
  resetAt: string | null;
  resetAtMs: number | null;
  dueAtMs: number | null;
  pollDueAtMs: number | null;
  pollAttempt: number;
  retryAttempt: number;
  refreshing: boolean;
  claimed: boolean;
  cancelled: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export interface QuotaAutoResumePendingView {
  readonly sessionId: string;
  readonly failedTurnId: string;
  readonly resetAt: string | null;
  readonly dueAtMs: number | null;
}

export interface ManagedQuotaErrorLike {
  readonly name?: string;
  readonly code?: string;
  readonly message?: string;
  readonly status_code?: number;
  readonly statusCode?: number;
}

export function isManagedQuotaError(error: ManagedQuotaErrorLike | null | undefined): boolean {
  if (error === undefined || error === null) return false;
  if (error.name === 'APIProviderQuotaExhaustedError' || error.code === 'quota_exhausted') return true;
  const status = error.status_code ?? error.statusCode;
  return status === 403 && error.message !== undefined && MANAGED_QUOTA_MESSAGE_PATTERN.test(error.message);
}

function knownWindows(usage: ManagedQuotaResult): readonly QuotaEntry[] | null {
  if (usage.kind !== 'ok') return null;
  const { limit5h, limit7d, monthTotal, monthCode } = usage.quota.usages;
  return [limit5h, limit7d, monthTotal, monthCode].filter((entry): entry is QuotaEntry => entry !== undefined);
}

function parseResetMs(resetAt: string | undefined): number | null {
  if (resetAt === undefined) return null;
  const ms = Date.parse(resetAt);
  return Number.isFinite(ms) ? ms : null;
}

function isPromptIdConflict(error: unknown): boolean {
  return isDaemonApiError(error) && error.code === PROMPT_ID_CONFLICT_CODE;
}

async function withSchedulerLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (locks?.request === undefined) return fn();
  return locks.request(SCHEDULER_LOCK_NAME, { mode: 'exclusive' }, () => fn());
}

export function createQuotaAutoResume(host: QuotaAutoResumeHost) {
  const now = host.now ?? Date.now;
  const random = host.random ?? Math.random;
  const withLock = host.withLock ?? withSchedulerLock;
  const ownerId = randomUUID();
  let pending: PendingResume | undefined;
  let running: PendingResume | undefined;
  const pendingView = shallowRef<QuotaAutoResumePendingView | null>(null);
  let ticker: ReturnType<typeof setInterval> | undefined;
  let standbyTimer: ReturnType<typeof setTimeout> | undefined;
  let consumedResetAtMs: number[] = [];
  let lastNullResetAtMs: number | undefined;

  function syncPendingView(): void {
    if (pending === undefined || !pending.claimed || !host.enabled()) {
      pendingView.value = null;
      return;
    }
    pendingView.value = {
      sessionId: pending.sessionId,
      failedTurnId: pending.failedTurnId,
      resetAt: pending.resetAt,
      dueAtMs: pending.dueAtMs,
    };
  }

  function readStoredReservation(): QuotaAutoResumeReservation | null {
    const raw = safeGetJson<unknown>(STORAGE_KEYS.quotaAutoResumeReservation);
    if (raw === null || typeof raw !== 'object') return null;
    const record = raw as Partial<QuotaAutoResumeReservation>;
    if (
      typeof record.ownerId !== 'string' ||
      typeof record.sessionId !== 'string' ||
      typeof record.failedTurnId !== 'string' ||
      typeof record.expiresAt !== 'number' ||
      !Number.isFinite(record.expiresAt)
    ) {
      return null;
    }
    return {
      ownerId: record.ownerId,
      sessionId: record.sessionId,
      failedTurnId: record.failedTurnId,
      resetAt: typeof record.resetAt === 'string' ? record.resetAt : null,
      expiresAt: record.expiresAt,
    };
  }

  function readActiveReservation(currentNow: number = now()): QuotaAutoResumeReservation | null {
    const record = readStoredReservation();
    return record !== null && record.expiresAt > currentNow ? record : null;
  }

  function writeReservation(task: PendingResume): void {
    const record: QuotaAutoResumeReservation = {
      ownerId,
      sessionId: task.sessionId,
      failedTurnId: task.failedTurnId,
      resetAt: task.resetAt,
      expiresAt: now() + QUOTA_AUTO_RESUME_RESERVATION_LEASE_MS,
    };
    safeSetJson(STORAGE_KEYS.quotaAutoResumeReservation, record);
  }

  function ownsReservation(task: PendingResume): boolean {
    const active = readActiveReservation();
    return active !== null && active.ownerId === ownerId && active.failedTurnId === task.failedTurnId;
  }

  function releaseReservation(task: PendingResume): void {
    const stored = readStoredReservation();
    if (stored === null || stored.ownerId !== ownerId || stored.failedTurnId !== task.failedTurnId) return;
    safeRemove(STORAGE_KEYS.quotaAutoResumeReservation);
  }

  function tryClaimOrRenew(task: PendingResume): Promise<boolean> {
    return withLock(async () => {
      if (!isCurrent(task) && running !== task) return false;
      const active = readActiveReservation();
      if (active !== null && (active.ownerId !== ownerId || active.failedTurnId !== task.failedTurnId)) return false;
      writeReservation(task);
      return true;
    });
  }

  function clearStandbyCheck(): void {
    if (standbyTimer !== undefined) clearTimeout(standbyTimer);
    standbyTimer = undefined;
  }

  function notifyReservationAvailable(): void {
    if (!host.enabled() || pending !== undefined || running !== undefined) return;
    if (readActiveReservation() !== null) return;
    host.onReservationAvailable?.();
  }

  function scheduleStandbyCheck(): void {
    if (standbyTimer !== undefined || !host.enabled() || host.onReservationAvailable === undefined) return;
    if (pending !== undefined || running !== undefined) return;
    const active = readActiveReservation();
    if (active === null) {
      notifyReservationAvailable();
      return;
    }
    const delay = Math.max(1_000, Math.min(active.expiresAt - now() + 50, QUOTA_AUTO_RESUME_TICK_MS));
    standbyTimer = setTimeout(() => {
      standbyTimer = undefined;
      if (!host.enabled() || pending !== undefined || running !== undefined) return;
      if (readActiveReservation() === null) notifyReservationAvailable();
      else scheduleStandbyCheck();
    }, delay);
  }

  function handleStorageEvent(event: StorageEvent): void {
    if (event.key !== STORAGE_KEYS.quotaAutoResumeReservation) return;
    const task = pending;
    if (task !== undefined) {
      if (task.claimed && !ownsReservation(task)) {
        dropPending(task, { release: false });
        scheduleStandbyCheck();
      }
      return;
    }
    if (readActiveReservation() === null) {
      clearStandbyCheck();
      notifyReservationAvailable();
    }
  }

  function handlePageHide(): void {
    clearStandbyCheck();
    if (pending !== undefined) dropPending(pending);
  }

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('storage', handleStorageEvent);
  }

  function jitterMs(): number {
    return QUOTA_AUTO_RESUME_MIN_JITTER_MS + Math.floor(random() * QUOTA_AUTO_RESUME_JITTER_SPAN_MS);
  }

  function readSharedConsumedResetAtMs(currentNow: number): number[] {
    const stored = safeGetJson<unknown>(STORAGE_KEYS.quotaAutoResumeConsumed);
    if (!Array.isArray(stored)) return [];
    return stored.filter(
      (ms): ms is number => typeof ms === 'number' && Number.isFinite(ms) && currentNow - ms <= QUOTA_AUTO_RESUME_MAX_WAIT_MS,
    );
  }

  function consumedWindows(currentNow: number): number[] {
    const merged = new Set([...consumedResetAtMs, ...readSharedConsumedResetAtMs(currentNow)]);
    return [...merged].filter((ms) => currentNow - ms <= QUOTA_AUTO_RESUME_MAX_WAIT_MS);
  }

  function isConsumedWindow(resetAtMs: number): boolean {
    return consumedWindows(now()).some((ms) => Math.abs(ms - resetAtMs) <= SAME_WINDOW_TOLERANCE_MS);
  }

  function recordConsumedWindow(resetAtMs: number): void {
    const next = [...consumedWindows(now()), resetAtMs];
    consumedResetAtMs = next;
    safeSetJson(STORAGE_KEYS.quotaAutoResumeConsumed, next);
  }

  function isExpired(task: PendingResume, atMs: number): boolean {
    return (
      atMs - task.armedAt > QUOTA_AUTO_RESUME_MAX_WAIT_MS ||
      (task.resetAtMs !== null && atMs - task.resetAtMs > QUOTA_AUTO_RESUME_GRACE_MS)
    );
  }

  function clearTaskTimer(task: PendingResume): void {
    if (task.timer !== undefined) clearTimeout(task.timer);
    task.timer = undefined;
  }

  function stopWatchdog(): void {
    if (ticker !== undefined) clearInterval(ticker);
    ticker = undefined;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', checkOverdue);
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('pagehide', handlePageHide);
    }
  }

  function startWatchdog(): void {
    clearStandbyCheck();
    if (ticker === undefined) ticker = setInterval(checkOverdue, QUOTA_AUTO_RESUME_TICK_MS);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', checkOverdue);
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.removeEventListener('pagehide', handlePageHide);
      window.addEventListener('pagehide', handlePageHide);
    }
  }

  function isCurrent(task: PendingResume): boolean {
    return !task.cancelled && pending === task && host.enabled();
  }

  function dropPending(task: PendingResume, opts: { release?: boolean } = {}): void {
    task.cancelled = true;
    clearTaskTimer(task);
    if (pending === task) pending = undefined;
    if (task.claimed && opts.release !== false) releaseReservation(task);
    task.claimed = false;
    if (pending === undefined) stopWatchdog();
    syncPendingView();
  }

  function scheduleFallbackPoll(task: PendingResume): void {
    if (now() - task.armedAt >= QUOTA_AUTO_RESUME_MAX_WAIT_MS) {
      dropPending(task);
      return;
    }
    const delays = QUOTA_AUTO_RESUME_FALLBACK_DELAYS_MS;
    const delay = delays[Math.min(task.pollAttempt, delays.length - 1)] ?? QUOTA_AUTO_RESUME_MAX_POLL_MS;
    task.pollAttempt += 1;
    task.dueAtMs = null;
    task.pollDueAtMs = now() + delay;
    clearTaskTimer(task);
    task.timer = setTimeout(() => {
      task.timer = undefined;
      if (isCurrent(task)) void refreshSchedule(task);
    }, delay);
    syncPendingView();
  }

  function scheduleAt(task: PendingResume, resetAt: string | null, resetAtMs: number | null, dueAtMs: number): void {
    task.resetAt = resetAt;
    task.resetAtMs = resetAtMs;
    task.dueAtMs = dueAtMs;
    task.pollDueAtMs = null;
    if (task.claimed && ownsReservation(task)) writeReservation(task);
    clearTaskTimer(task);
    task.timer = setTimeout(() => {
      task.timer = undefined;
      if (isCurrent(task)) void fire(task);
    }, Math.max(0, dueAtMs - now()));
    syncPendingView();
  }

  async function refreshSchedule(task: PendingResume): Promise<void> {
    if (!isCurrent(task) || task.refreshing) return;
    task.refreshing = true;
    try {
      if (!(await host.isManagedKimiSession(task.sessionId))) {
        dropPending(task);
        return;
      }
      if (!isCurrent(task)) return;
      const usage = await host.getUsage(task.sessionId);
      if (!isCurrent(task)) return;
      const known = knownWindows(usage);
      if (known === null || known.length === 0) {
        scheduleFallbackPoll(task);
        return;
      }
      const exhausted = known.filter((entry) => entry.usedRatio >= 1);
      const currentNow = now();
      if (exhausted.length === 0) {
        if (lastNullResetAtMs !== undefined && currentNow - lastNullResetAtMs < QUOTA_AUTO_RESUME_NULL_RESET_COOLDOWN_MS) {
          dropPending(task);
          return;
        }
        scheduleAt(task, null, null, currentNow + jitterMs());
        return;
      }
      const resetTimes = exhausted
        .map((entry) => parseResetMs(entry.resetAt))
        .filter((ms): ms is number => ms !== null);
      if (resetTimes.length < exhausted.length) {
        scheduleFallbackPoll(task);
        return;
      }
      const resetAtMs = Math.max(...resetTimes);
      if (
        resetAtMs - currentNow > QUOTA_AUTO_RESUME_MAX_WAIT_MS ||
        currentNow - resetAtMs > QUOTA_AUTO_RESUME_GRACE_MS ||
        isConsumedWindow(resetAtMs)
      ) {
        dropPending(task);
        return;
      }
      scheduleAt(task, new Date(resetAtMs).toISOString(), resetAtMs, Math.max(currentNow + jitterMs(), resetAtMs + jitterMs()));
    } catch {
      if (isCurrent(task)) scheduleFallbackPoll(task);
    } finally {
      task.refreshing = false;
    }
  }

  function retryOrGiveUp(task: PendingResume, error: unknown): void {
    if (running === task) running = undefined;
    const currentNow = now();
    const delay = QUOTA_AUTO_RESUME_RETRY_DELAYS_MS[task.retryAttempt];
    if (delay === undefined || isExpired(task, currentNow) || isExpired(task, currentNow + delay)) {
      task.cancelled = true;
      releaseReservation(task);
      task.claimed = false;
      syncPendingView();
      host.onGiveUp?.(task.sessionId, error);
      return;
    }
    task.retryAttempt += 1;
    pending = task;
    task.claimed = true;
    startWatchdog();
    scheduleAt(task, task.resetAt, task.resetAtMs, currentNow + delay);
  }

  async function fire(task: PendingResume): Promise<void> {
    if (!isCurrent(task) || task.dueAtMs === null) return;
    const currentNow = now();
    if (currentNow < task.dueAtMs) {
      scheduleAt(task, task.resetAt, task.resetAtMs, task.dueAtMs);
      return;
    }
    if (isExpired(task, currentNow)) {
      dropPending(task);
      return;
    }
    clearTaskTimer(task);
    pending = undefined;
    running = task;
    stopWatchdog();
    syncPendingView();
    let failure: { error: unknown } | undefined;
    const releaseAndStop = (): void => {
      releaseReservation(task);
      task.claimed = false;
    };
    try {
      await withLock(async () => {
        if (task.cancelled || !host.enabled()) return;
        const active = readActiveReservation();
        if (active !== null && (active.ownerId !== ownerId || active.failedTurnId !== task.failedTurnId)) {
          task.claimed = false;
          return;
        }
        if (task.resetAtMs !== null && isConsumedWindow(task.resetAtMs)) {
          releaseAndStop();
          return;
        }
        if (!(await host.isManagedKimiSession(task.sessionId))) {
          releaseAndStop();
          return;
        }
        if (task.cancelled || !host.enabled()) return;
        const ready = await host.checkSessionReady(task.sessionId, task.failedTurnId);
        if (task.cancelled || !host.enabled()) return;
        if (!ready) {
          releaseAndStop();
          return;
        }
        if (task.resetAtMs !== null && isConsumedWindow(task.resetAtMs)) {
          releaseAndStop();
          return;
        }
        writeReservation(task);
        try {
          await host.submitResume(task.sessionId, {
            turnId: task.failedTurnId,
            resetAt: task.resetAt,
            promptId: task.promptId,
          });
        } catch (err) {
          if (!isPromptIdConflict(err)) {
            failure = { error: err };
            return;
          }
        }
        if (task.resetAtMs !== null) recordConsumedWindow(task.resetAtMs);
        else lastNullResetAtMs = now();
        releaseAndStop();
      });
      if (failure !== undefined && !task.cancelled && host.enabled()) {
        retryOrGiveUp(task, failure.error);
      }
    } catch (err) {
      if (!task.cancelled && host.enabled()) retryOrGiveUp(task, err);
    } finally {
      if (running === task) running = undefined;
    }
  }

  function checkOverdue(): void {
    const task = pending;
    if (task === undefined) return;
    if (!host.enabled()) {
      clearAll();
      return;
    }
    const currentNow = now();
    if (isExpired(task, currentNow)) {
      dropPending(task);
      return;
    }
    if (task.dueAtMs !== null && currentNow >= task.dueAtMs) {
      clearTaskTimer(task);
      void fire(task);
    } else if (task.pollDueAtMs !== null && currentNow >= task.pollDueAtMs && !task.refreshing) {
      clearTaskTimer(task);
      void refreshSchedule(task);
    } else if (task.claimed && !task.refreshing) {
      void (async () => {
        if (!(await tryClaimOrRenew(task)) && isCurrent(task)) {
          dropPending(task, { release: false });
          scheduleStandbyCheck();
        }
      })();
    }
  }

  function handleTurnFailed(sessionId: string, failedTurnId: string, error: ConversationError | undefined): void {
    if (!host.enabled() || pending !== undefined || running !== undefined) return;
    if (!isManagedQuotaError(error)) return;
    const task: PendingResume = {
      sessionId,
      failedTurnId,
      promptId: stablePromptId(`kimi-quota-auto-resume:${sessionId}:${failedTurnId}`),
      armedAt: now(),
      resetAt: null,
      resetAtMs: null,
      dueAtMs: null,
      pollDueAtMs: null,
      pollAttempt: 0,
      retryAttempt: 0,
      refreshing: false,
      claimed: false,
      cancelled: false,
      timer: undefined,
    };
    pending = task;
    startWatchdog();
    void (async () => {
      if (!(await tryClaimOrRenew(task))) {
        if (isCurrent(task)) {
          dropPending(task);
          scheduleStandbyCheck();
        }
        return;
      }
      if (!isCurrent(task)) return;
      task.claimed = true;
      syncPendingView();
      await refreshSchedule(task);
    })();
  }

  function cancelSession(sessionId: string): void {
    if (pending?.sessionId === sessionId) dropPending(pending);
    if (running?.sessionId === sessionId) running.cancelled = true;
  }

  function clearAll(): void {
    clearStandbyCheck();
    if (pending !== undefined) dropPending(pending);
    if (running !== undefined) running.cancelled = true;
    stopWatchdog();
    syncPendingView();
  }

  function pendingFor(sessionId: string, failedTurnId?: string): QuotaAutoResumePendingView | null {
    const view = pendingView.value;
    if (view === null || view.sessionId !== sessionId) return null;
    if (failedTurnId !== undefined && view.failedTurnId !== failedTurnId) return null;
    return view;
  }

  return {
    handleTurnFailed,
    cancelSession,
    clearAll,
    pendingFor,
    hasPending: () => pending !== undefined || running !== undefined,
  };
}
