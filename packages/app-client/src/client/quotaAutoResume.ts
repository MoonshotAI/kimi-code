import { shallowRef } from 'vue';
import { isDaemonApiError, type ManagedQuotaResult, type QuotaEntry } from '@moonshot-ai/app-core/api';
import type { ConversationError } from '@moonshot-ai/app-core/conversation';
import { STORAGE_KEYS, safeGetJson, safeGetString, safeRemove, safeSetJson } from '@moonshot-ai/app-core/lib';
import { stablePromptId } from './promptId';

export const QUOTA_AUTO_RESUME_MAX_WAIT_MS = 24 * 60 * 60 * 1000;
export const QUOTA_AUTO_RESUME_GRACE_MS = 30 * 60 * 1000;
export const QUOTA_AUTO_RESUME_TICK_MS = 60 * 1000;
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
  withLock?: <T>(fn: () => Promise<T>) => Promise<T>;
  now?: () => number;
  random?: () => number;
}

export interface QuotaAutoResumePendingRecord {
  readonly sessionId: string;
  readonly failedTurnId: string;
  readonly resetAt: string | null;
  readonly updatedAt: number;
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
  cancelled: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export interface QuotaAutoResumePendingView {
  readonly sessionId: string;
  readonly failedTurnId: string;
  readonly resetAt: string | null;
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
  let pending: PendingResume | undefined;
  let running: PendingResume | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let consumedResetAtMs: number[] = [];
  let lastNullResetAtMs: number | undefined;

  function isSameReservation(record: QuotaAutoResumePendingRecord, sessionId: string, failedTurnId: string): boolean {
    return record.sessionId === sessionId && record.failedTurnId === failedTurnId;
  }

  function isExpiredReservation(record: QuotaAutoResumePendingRecord, currentNow: number): boolean {
    if (currentNow - record.updatedAt > QUOTA_AUTO_RESUME_MAX_WAIT_MS) return true;
    if (record.resetAt === null) {
      return currentNow - record.updatedAt > 2 * QUOTA_AUTO_RESUME_MAX_POLL_MS;
    }
    const resetAtMs = parseResetMs(record.resetAt);
    if (resetAtMs === null) return true;
    return resetAtMs - currentNow > QUOTA_AUTO_RESUME_MAX_WAIT_MS || currentNow - resetAtMs > QUOTA_AUTO_RESUME_GRACE_MS;
  }

  function parseStoredReservation(raw: string | null): QuotaAutoResumePendingRecord | null {
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (parsed === null || typeof parsed !== 'object') return null;
    const record = parsed as Partial<QuotaAutoResumePendingRecord>;
    if (
      typeof record.sessionId !== 'string' ||
      record.sessionId === '' ||
      typeof record.failedTurnId !== 'string' ||
      record.failedTurnId === '' ||
      (record.resetAt !== null && typeof record.resetAt !== 'string') ||
      typeof record.updatedAt !== 'number' ||
      !Number.isFinite(record.updatedAt)
    ) {
      return null;
    }
    return {
      sessionId: record.sessionId,
      failedTurnId: record.failedTurnId,
      resetAt: record.resetAt ?? null,
      updatedAt: record.updatedAt,
    };
  }

  function readActiveReservation(): QuotaAutoResumePendingRecord | null {
    const record = parseStoredReservation(safeGetString(STORAGE_KEYS.quotaAutoResumePending));
    if (record !== null && isExpiredReservation(record, now())) {
      safeRemove(STORAGE_KEYS.quotaAutoResumePending);
      return null;
    }
    return record;
  }

  const sharedPending = shallowRef<QuotaAutoResumePendingRecord | null>(readActiveReservation());
  const pendingView = shallowRef<QuotaAutoResumePendingView | null>(null);

  function syncPendingView(): void {
    const shared = sharedPending.value;
    if (!host.enabled() || shared === null) {
      pendingView.value = null;
      return;
    }
    const local =
      pending !== undefined && isSameReservation(shared, pending.sessionId, pending.failedTurnId) ? pending : undefined;
    const resetAt = local?.resetAt ?? shared.resetAt;
    pendingView.value =
      resetAt === null ? null : { sessionId: shared.sessionId, failedTurnId: shared.failedTurnId, resetAt };
  }

  function writeStoredReservation(task: PendingResume): void {
    const record: QuotaAutoResumePendingRecord = {
      sessionId: task.sessionId,
      failedTurnId: task.failedTurnId,
      resetAt: task.resetAt,
      updatedAt: now(),
    };
    safeSetJson(STORAGE_KEYS.quotaAutoResumePending, record);
    sharedPending.value = record;
  }

  function refreshStoredReservation(task: PendingResume): void {
    const active = readActiveReservation();
    if (active !== null && isSameReservation(active, task.sessionId, task.failedTurnId)) {
      writeStoredReservation(task);
    }
  }

  function releaseStoredReservation(task: PendingResume): void {
    const stored = parseStoredReservation(safeGetString(STORAGE_KEYS.quotaAutoResumePending));
    if (stored === null || !isSameReservation(stored, task.sessionId, task.failedTurnId)) return;
    safeRemove(STORAGE_KEYS.quotaAutoResumePending);
    sharedPending.value = null;
  }

  function claimReservation(task: PendingResume): Promise<boolean> {
    return withLock(async () => {
      if (!isCurrent(task)) return false;
      const active = readActiveReservation();
      if (active !== null && !isSameReservation(active, task.sessionId, task.failedTurnId)) {
        sharedPending.value = active;
        return false;
      }
      writeStoredReservation(task);
      return true;
    });
  }

  function handleStorageEvent(event: StorageEvent): void {
    if (event.key !== STORAGE_KEYS.quotaAutoResumePending) return;
    const next = parseStoredReservation(event.newValue);
    sharedPending.value = next !== null && !isExpiredReservation(next, now()) ? next : null;
    const task = pending;
    if (
      task !== undefined &&
      sharedPending.value !== null &&
      !isSameReservation(sharedPending.value, task.sessionId, task.failedTurnId)
    ) {
      dropPending(task, { release: false });
      return;
    }
    syncPendingView();
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

  function isNullResetCoolingDown(currentNow: number): boolean {
    if (lastNullResetAtMs !== undefined && currentNow - lastNullResetAtMs < QUOTA_AUTO_RESUME_NULL_RESET_COOLDOWN_MS) {
      return true;
    }
    const stored = safeGetJson<unknown>(STORAGE_KEYS.quotaAutoResumeNullResetAt);
    return (
      typeof stored === 'number' &&
      Number.isFinite(stored) &&
      currentNow - stored >= 0 &&
      currentNow - stored < QUOTA_AUTO_RESUME_NULL_RESET_COOLDOWN_MS
    );
  }

  function recordNullResetCooldown(atMs: number): void {
    lastNullResetAtMs = atMs;
    safeSetJson(STORAGE_KEYS.quotaAutoResumeNullResetAt, atMs);
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
  }

  function startWatchdog(): void {
    if (ticker === undefined) ticker = setInterval(checkOverdue, QUOTA_AUTO_RESUME_TICK_MS);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', checkOverdue);
  }

  function isCurrent(task: PendingResume): boolean {
    return !task.cancelled && pending === task && host.enabled();
  }

  function dropPending(task: PendingResume, opts: { release?: boolean } = {}): void {
    task.cancelled = true;
    clearTaskTimer(task);
    if (pending === task) pending = undefined;
    if (opts.release !== false) releaseStoredReservation(task);
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
    refreshStoredReservation(task);
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
    refreshStoredReservation(task);
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
        if (isNullResetCoolingDown(currentNow)) {
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
      releaseStoredReservation(task);
      syncPendingView();
      host.onGiveUp?.(task.sessionId, error);
      return;
    }
    task.retryAttempt += 1;
    pending = task;
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
    const releaseAndStop = (): void => releaseStoredReservation(task);
    try {
      await withLock(async () => {
        if (task.cancelled || !host.enabled()) return;
        const active = readActiveReservation();
        if (active !== null && !isSameReservation(active, task.sessionId, task.failedTurnId)) {
          sharedPending.value = active;
          return;
        }
        if (task.resetAtMs !== null && isConsumedWindow(task.resetAtMs)) {
          releaseAndStop();
          return;
        }
        if (task.resetAtMs === null && isNullResetCoolingDown(now())) {
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
        if (task.resetAtMs === null && isNullResetCoolingDown(now())) {
          releaseAndStop();
          return;
        }
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
        else recordNullResetCooldown(now());
        releaseAndStop();
      });
      if (failure !== undefined && !task.cancelled && host.enabled()) {
        retryOrGiveUp(task, failure.error);
      }
    } catch (err) {
      if (!task.cancelled && host.enabled()) retryOrGiveUp(task, err);
    } finally {
      if (running === task) running = undefined;
      syncPendingView();
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
      cancelled: false,
      timer: undefined,
    };
    pending = task;
    startWatchdog();
    void (async () => {
      if (!(await claimReservation(task))) {
        if (isCurrent(task)) dropPending(task, { release: false });
        return;
      }
      if (!isCurrent(task)) return;
      syncPendingView();
      await refreshSchedule(task);
    })();
  }

  function cancelSession(sessionId: string): void {
    if (pending?.sessionId === sessionId) dropPending(pending);
    if (running?.sessionId === sessionId) {
      running.cancelled = true;
      releaseStoredReservation(running);
      syncPendingView();
    }
  }

  function clearAll(): void {
    if (pending !== undefined) dropPending(pending);
    if (running !== undefined) {
      running.cancelled = true;
      releaseStoredReservation(running);
    }
    if (!host.enabled()) {
      safeRemove(STORAGE_KEYS.quotaAutoResumePending);
      sharedPending.value = null;
    }
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
