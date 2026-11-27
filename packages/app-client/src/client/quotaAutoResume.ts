import type { ManagedQuotaResult, QuotaEntry } from '@moonshot-ai/app-core/api';
import type { ConversationError } from '@moonshot-ai/app-core/conversation';

export const QUOTA_AUTO_RESUME_MAX_WAIT_MS = 24 * 60 * 60 * 1000;
export const QUOTA_AUTO_RESUME_GRACE_MS = 30 * 60 * 1000;
export const QUOTA_AUTO_RESUME_TICK_MS = 60 * 1000;
export const QUOTA_AUTO_RESUME_MIN_JITTER_MS = 5_000;
export const QUOTA_AUTO_RESUME_JITTER_SPAN_MS = 10_000;
export const QUOTA_AUTO_RESUME_MAX_POLL_MS = 15 * 60 * 1000;
export const QUOTA_AUTO_RESUME_FALLBACK_DELAYS_MS = [60 * 1000, 5 * 60 * 1000, QUOTA_AUTO_RESUME_MAX_POLL_MS] as const;

const SAME_WINDOW_TOLERANCE_MS = 60 * 1000;
const MANAGED_QUOTA_MESSAGE_PATTERN = /usage limit|quota|5-hour|7-day|weekly|monthly|billing cycle/i;

export interface QuotaAutoResumeHost {
  enabled: () => boolean;
  isManagedKimiSession: (sessionId: string) => boolean;
  getUsage: () => Promise<ManagedQuotaResult>;
  checkSessionReady: (sessionId: string, failedTurnId: string) => Promise<boolean>;
  submitResume: (sessionId: string, input: { turnId: string; resetAt: string | null }) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

interface PendingResume {
  readonly sessionId: string;
  readonly failedTurnId: string;
  readonly armedAt: number;
  resetAt: string | null;
  resetAtMs: number | null;
  dueAtMs: number | null;
  pollDueAtMs: number | null;
  pollAttempt: number;
  refreshing: boolean;
  cancelled: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export function isManagedQuotaError(error: ConversationError | undefined): boolean {
  if (error === undefined) return false;
  if (error.name === 'APIProviderQuotaExhaustedError' || error.code === 'quota_exhausted') return true;
  return error.status_code === 403 && MANAGED_QUOTA_MESSAGE_PATTERN.test(error.message);
}

function exhaustedWindows(usage: ManagedQuotaResult): readonly QuotaEntry[] | null {
  if (usage.kind !== 'ok') return null;
  const { limit5h, limit7d, monthTotal, monthCode } = usage.quota.usages;
  return [limit5h, limit7d, monthTotal, monthCode].filter(
    (entry): entry is QuotaEntry => entry !== undefined && entry.usedRatio >= 1,
  );
}

function parseResetMs(resetAt: string | undefined): number | null {
  if (resetAt === undefined) return null;
  const ms = Date.parse(resetAt);
  return Number.isFinite(ms) ? ms : null;
}

export function createQuotaAutoResume(host: QuotaAutoResumeHost) {
  const now = host.now ?? Date.now;
  const random = host.random ?? Math.random;
  let pending: PendingResume | undefined;
  let running: PendingResume | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let consumedResetAtMs: number[] = [];

  function jitterMs(): number {
    return QUOTA_AUTO_RESUME_MIN_JITTER_MS + Math.floor(random() * QUOTA_AUTO_RESUME_JITTER_SPAN_MS);
  }

  function isConsumedWindow(resetAtMs: number): boolean {
    return consumedResetAtMs.some((ms) => Math.abs(ms - resetAtMs) <= SAME_WINDOW_TOLERANCE_MS);
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

  function dropPending(task: PendingResume): void {
    task.cancelled = true;
    clearTaskTimer(task);
    if (pending === task) pending = undefined;
    if (pending === undefined) stopWatchdog();
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
  }

  function scheduleAt(task: PendingResume, resetAt: string | null, resetAtMs: number | null, dueAtMs: number): void {
    task.resetAt = resetAt;
    task.resetAtMs = resetAtMs;
    task.dueAtMs = dueAtMs;
    task.pollDueAtMs = null;
    clearTaskTimer(task);
    task.timer = setTimeout(() => {
      task.timer = undefined;
      if (isCurrent(task)) void fire(task);
    }, Math.max(0, dueAtMs - now()));
  }

  async function refreshSchedule(task: PendingResume): Promise<void> {
    if (!isCurrent(task) || task.refreshing) return;
    task.refreshing = true;
    try {
      const usage = await host.getUsage();
      if (!isCurrent(task)) return;
      consumedResetAtMs = consumedResetAtMs.filter((ms) => now() - ms <= QUOTA_AUTO_RESUME_MAX_WAIT_MS);
      const exhausted = exhaustedWindows(usage);
      if (exhausted === null) {
        scheduleFallbackPoll(task);
        return;
      }
      if (exhausted.length === 0) {
        scheduleAt(task, null, null, now() + jitterMs());
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
      const currentNow = now();
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

  async function fire(task: PendingResume): Promise<void> {
    if (!isCurrent(task) || task.dueAtMs === null) return;
    const currentNow = now();
    if (currentNow < task.dueAtMs) {
      scheduleAt(task, task.resetAt, task.resetAtMs, task.dueAtMs);
      return;
    }
    if (task.resetAtMs !== null && currentNow - task.resetAtMs > QUOTA_AUTO_RESUME_GRACE_MS) {
      dropPending(task);
      return;
    }
    clearTaskTimer(task);
    pending = undefined;
    running = task;
    stopWatchdog();
    try {
      const ready = await host.checkSessionReady(task.sessionId, task.failedTurnId);
      if (task.cancelled || !host.enabled() || !ready) return;
      if (task.resetAtMs !== null) consumedResetAtMs.push(task.resetAtMs);
      await host.submitResume(task.sessionId, { turnId: task.failedTurnId, resetAt: task.resetAt });
    } catch {
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
    if (
      currentNow - task.armedAt > QUOTA_AUTO_RESUME_MAX_WAIT_MS ||
      (task.resetAtMs !== null && currentNow - task.resetAtMs > QUOTA_AUTO_RESUME_GRACE_MS)
    ) {
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
    if (!host.isManagedKimiSession(sessionId) || !isManagedQuotaError(error)) return;
    const task: PendingResume = {
      sessionId,
      failedTurnId,
      armedAt: now(),
      resetAt: null,
      resetAtMs: null,
      dueAtMs: null,
      pollDueAtMs: null,
      pollAttempt: 0,
      refreshing: false,
      cancelled: false,
      timer: undefined,
    };
    pending = task;
    startWatchdog();
    void refreshSchedule(task);
  }

  function cancelSession(sessionId: string): void {
    if (pending?.sessionId === sessionId) dropPending(pending);
    if (running?.sessionId === sessionId) running.cancelled = true;
  }

  function clearAll(): void {
    if (pending !== undefined) dropPending(pending);
    if (running !== undefined) running.cancelled = true;
    stopWatchdog();
  }

  return {
    handleTurnFailed,
    cancelSession,
    clearAll,
    hasPending: () => pending !== undefined || running !== undefined,
  };
}
