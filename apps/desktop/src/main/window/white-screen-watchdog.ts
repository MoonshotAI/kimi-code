import type { WebContents } from 'electron';

import { withTimeout } from '../diagnostics/collector';
import { writeIncident } from '../diagnostics/incidents';
import { markRendererGone } from '../app/launch-state';
import { log, onStartupStep } from '../diagnostics/log';
import type { WhiteScreenSuspectedEvent } from '../diagnostics/telemetry-events';
import { trackDesktopEvent } from '../diagnostics/track';

export const STARTUP_STALL_MS = 10_000;
export const MOUNT_STALL_MS = 10_000;
export const BOOT_STALL_MS = 60_000;
export const RENDERER_GONE_GRACE_MS = 5_000;
export const STACK_SAMPLE_INTERVAL_MS = 1_000;
export const MAX_STACK_SAMPLES = 8;
const STACK_TIMEOUT_MS = 2_000;
const MAX_STACK_CHARS = 4_000;
const MAX_INCIDENTS_PER_KIND = 2;

type SuspectKind = WhiteScreenSuspectedEvent['kind'];
type Timer = ReturnType<typeof setTimeout>;

interface UnresponsiveEpisode {
  readonly since: number;
  end: 'responsive' | 'renderer-gone' | null;
}

const INCIDENT_NAMES: Record<SuspectKind, string> = {
  startup_stalled: 'startup-stalled',
  not_mounted: 'not-mounted',
  boot_stalled: 'boot-stalled',
  unresponsive: 'unresponsive',
  renderer_gone: 'renderer-gone',
};

export type WatchedContents = Pick<WebContents, 'on' | 'once' | 'getURL' | 'isDestroyed'> & {
  readonly mainFrame?: { collectJavaScriptCallStack(): Promise<string> | Promise<void> };
};

export interface WatchdogOptions {
  isAppUrl: (url: string) => boolean;
  isQuitting: () => boolean;
  now?: () => number;
}

function later(callback: () => void, ms: number): Timer {
  const timer = setTimeout(callback, ms);
  timer.unref?.();
  return timer;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    later(resolve, ms);
  });
}

export function groupStacks(samples: readonly string[]): Array<{ stack: string; count: number }> {
  const counts = new Map<string, number>();
  for (const sample of samples) counts.set(sample, (counts.get(sample) ?? 0) + 1);
  return [...counts].map(([stack, count]) => ({ stack, count })).sort((a, b) => b.count - a.count);
}

export function attachWhiteScreenWatchdog(contents: WatchedContents, options: WatchdogOptions): () => void {
  const now = options.now ?? Date.now;
  const createdAt = now();
  const incidents = new Map<SuspectKind, number>();
  let lastStep = 'window-created';
  let firstDocumentLoaded = false;
  let mountedInDocument = false;
  let startupStalled = false;
  let startupPaused = false;
  let disposed = false;
  let unresponsive: UnresponsiveEpisode | null = null;
  let startupTimer: Timer | null = null;
  let mountTimer: Timer | null = null;
  let bootTimer: Timer | null = null;

  const stopStartupTimer = (): void => {
    if (startupTimer !== null) clearTimeout(startupTimer);
    startupTimer = null;
  };
  const stopMountTimer = (): void => {
    if (mountTimer !== null) clearTimeout(mountTimer);
    mountTimer = null;
  };
  const stopBootTimer = (): void => {
    if (bootTimer !== null) clearTimeout(bootTimer);
    bootTimer = null;
  };

  const suspect = (kind: SuspectKind, since: number, probePage: boolean, details?: Record<string, unknown>): void => {
    if (disposed) return;
    const count = incidents.get(kind) ?? 0;
    if (count >= MAX_INCIDENTS_PER_KIND) return;
    incidents.set(kind, count + 1);
    const elapsed = Math.max(0, Math.round(now() - since));
    trackDesktopEvent('white_screen_suspected', { kind, stage: lastStep, elapsed_ms: elapsed });
    void writeIncident({
      kind: INCIDENT_NAMES[kind],
      summary: `${INCIDENT_NAMES[kind]} stage=${lastStep} after=${elapsed}ms`,
      contents: probePage && !contents.isDestroyed() ? (contents as WebContents) : null,
      details,
    });
  };

  const collectStack = async (): Promise<string | null> => {
    try {
      const frame = contents.isDestroyed() ? undefined : contents.mainFrame;
      if (frame === undefined || typeof frame.collectJavaScriptCallStack !== 'function') return null;
      const pending: Promise<string | void> = frame.collectJavaScriptCallStack();
      const stack = await withTimeout(pending, STACK_TIMEOUT_MS);
      return typeof stack === 'string' && stack !== '' ? stack.slice(0, MAX_STACK_CHARS) : null;
    } catch {
      return null;
    }
  };

  const endUnresponsive = (end: 'responsive' | 'renderer-gone'): void => {
    if (unresponsive !== null) unresponsive.end = end;
    unresponsive = null;
  };

  const sampleWhileUnresponsive = async (episode: UnresponsiveEpisode): Promise<void> => {
    const samples: string[] = [];
    for (let attempt = 0; attempt < MAX_STACK_SAMPLES && episode.end === null && !disposed; attempt += 1) {
      const stack = await collectStack();
      if (stack !== null) samples.push(stack);
      await delay(STACK_SAMPLE_INTERVAL_MS);
    }
    suspect('unresponsive', episode.since, false, {
      recovered: episode.end === 'responsive',
      rendererGone: episode.end === 'renderer-gone',
      stacks: groupStacks(samples),
    });
  };

  const startStartupTimer = (): void => {
    const startedAt = now();
    startupTimer = later(() => {
      startupTimer = null;
      startupStalled = true;
      suspect('startup_stalled', startedAt, true);
    }, STARTUP_STALL_MS);
  };
  startStartupTimer();

  const unsubscribe = onStartupStep((entry) => {
    lastStep = entry.step;
    if (entry.step === 'connect-failed' || entry.step === 'web-assets-wait') {
      stopStartupTimer();
      startupPaused = true;
    } else if (startupPaused && !firstDocumentLoaded && (entry.step === 'server-start' || entry.step === 'load-url')) {
      startupPaused = false;
      startStartupTimer();
    } else if (entry.step === 'ui-mounted') {
      mountedInDocument = true;
      stopMountTimer();
      stopBootTimer();
      const mountedAt = now();
      bootTimer = later(() => {
        bootTimer = null;
        suspect('boot_stalled', mountedAt, true);
      }, BOOT_STALL_MS);
    } else if (entry.step === 'ui-ready') {
      stopBootTimer();
    }
  });

  contents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    mountedInDocument = false;
    stopMountTimer();
    stopBootTimer();
  });
  contents.on('did-finish-load', () => {
    if (contents.isDestroyed() || !options.isAppUrl(contents.getURL())) return;
    if (!firstDocumentLoaded) {
      firstDocumentLoaded = true;
      stopStartupTimer();
      if (startupStalled) log.info(`[white-screen] startup-stalled resolved after=${Math.round(now() - createdAt)}ms`);
    }
    stopMountTimer();
    if (mountedInDocument) return;
    const loadedAt = now();
    mountTimer = later(() => {
      mountTimer = null;
      suspect('not_mounted', loadedAt, true);
    }, MOUNT_STALL_MS);
  });
  contents.on('render-process-gone', (_event, details) => {
    mountedInDocument = false;
    stopMountTimer();
    stopBootTimer();
    endUnresponsive('renderer-gone');
    if (details.reason === 'clean-exit') return;
    const goneAt = now();
    later(() => {
      if (disposed || options.isQuitting() || contents.isDestroyed()) return;
      markRendererGone();
      suspect('renderer_gone', goneAt, false, { reason: details.reason, exitCode: details.exitCode });
    }, RENDERER_GONE_GRACE_MS);
  });
  contents.on('unresponsive', () => {
    if (unresponsive !== null) return;
    const episode: UnresponsiveEpisode = { since: now(), end: null };
    unresponsive = episode;
    void sampleWhileUnresponsive(episode);
  });
  contents.on('responsive', () => {
    endUnresponsive('responsive');
  });

  const dispose = (): void => {
    disposed = true;
    unsubscribe();
    stopStartupTimer();
    stopMountTimer();
    stopBootTimer();
    unresponsive = null;
  };
  contents.once('destroyed', dispose);
  return dispose;
}
