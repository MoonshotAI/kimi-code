import { track } from '../contracts';

const BUSY_WINDOW_MERGE_GAP_MS = 2_000;

interface BusyWindow {
  sessionId: string;
  t0: number;
  endedAt: number | undefined;
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface SessionOpenBaseline {
  cached: boolean;
  baseline: Promise<void>;
  isLoaded: () => boolean;
  isCurrent: () => boolean;
}

let longtaskObserverRunning: boolean | undefined;
let busyWindow: BusyWindow | undefined;
let pendingBusyReport: ReturnType<typeof setTimeout> | undefined;

function recordLongtask(durationMs: number): void {
  const win = busyWindow;
  if (win === undefined || win.endedAt !== undefined) return;
  win.count += 1;
  win.totalMs += durationMs;
  win.maxMs = Math.max(win.maxMs, durationMs);
}

function startLongtaskObserver(): boolean {
  if (typeof PerformanceObserver === 'undefined') return false;
  if (!PerformanceObserver.supportedEntryTypes.includes('longtask')) return false;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) recordLongtask(entry.duration);
    }).observe({ type: 'longtask' });
    return true;
  } catch {
    return false;
  }
}

function nextFrame(callback: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(callback);
  else setTimeout(callback, 0);
}

function cancelPendingBusyReport(): void {
  if (pendingBusyReport === undefined) return;
  clearTimeout(pendingBusyReport);
  pendingBusyReport = undefined;
}

function reportBusyWindow(): void {
  cancelPendingBusyReport();
  const win = busyWindow;
  if (win === undefined) return;
  busyWindow = undefined;
  track('session_busy_longtasks', {
    session_id: win.sessionId,
    longtask_count: win.count,
    longtask_total_ms: Math.round(win.totalMs),
    longtask_max_ms: Math.round(win.maxMs),
    busy_duration_ms: Math.round((win.endedAt ?? performance.now()) - win.t0),
  });
}

export function openSessionBusyWindow(sessionId: string): void {
  if (busyWindow?.sessionId === sessionId) {
    cancelPendingBusyReport();
    busyWindow.endedAt = undefined;
    return;
  }
  reportBusyWindow();
  longtaskObserverRunning ??= startLongtaskObserver();
  if (!longtaskObserverRunning) return;
  busyWindow = { sessionId, t0: performance.now(), endedAt: undefined, count: 0, totalMs: 0, maxMs: 0 };
}

export function closeSessionBusyWindow(): void {
  const win = busyWindow;
  if (win === undefined || win.endedAt !== undefined) return;
  win.endedAt = performance.now();
  pendingBusyReport = setTimeout(reportBusyWindow, BUSY_WINDOW_MERGE_GAP_MS);
}

export function startSessionOpenTiming(sessionId: string): (opened: SessionOpenBaseline) => void {
  const t0 = performance.now();
  return ({ cached, baseline, isLoaded, isCurrent }) => {
    const report = () => {
      if (!isCurrent()) return;
      track('session_open_timing', {
        session_id: sessionId,
        duration_ms: Math.round(performance.now() - t0),
        cached,
      });
    };
    void baseline.then(() => {
      if (!isCurrent() || !isLoaded()) return;
      nextFrame(report);
    }, () => {});
  };
}
