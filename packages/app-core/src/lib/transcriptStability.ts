export type StabilityEvent =
  | { kind: 'shift'; atBottom: boolean; delta: number; target: string }
  | { kind: 'blank'; height: number }
  | { kind: 'ro-loop' }
  | { kind: 'multi-write'; writes: number };

export interface StabilityReport {
  frames: number;
  samples: number;
  shifts: number;
  maxShiftPx: number;
  followLags: number;
  blankFrames: number;
  roLoops: number;
  writes: number;
  maxWritesPerFrame: number;
  multiWriteFrames: number;
  layoutShift: number;
  longTasks: number;
  longTaskMs: number;
  frameP50Ms: number;
  frameP95Ms: number;
  frameMaxMs: number;
}

export interface StabilityScheduler {
  frame(callback: (time: number) => void): number;
  cancelFrame(id: number): void;
  afterPaint(callback: () => void): void;
  now(): number;
  dispose?(): void;
}

export interface StabilityProbeOptions {
  placeholderSelector?: string;
  inputQuietMs?: number;
  scrollChainMs?: number;
  tolerancePx?: number;
  readingLine?: number;
  onEvent?: (event: StabilityEvent) => void;
  scheduler?: StabilityScheduler;
}

export interface StabilityProbe {
  report(): StabilityReport;
  reset(): void;
  markInput(): void;
  stop(): void;
}

type ScrollMethod = (...args: unknown[]) => void;
type LayoutShiftEntry = PerformanceEntry & { value: number; hadRecentInput: boolean };

const INPUT_EVENTS = ['wheel', 'keydown', 'pointerdown', 'touchstart', 'touchmove'] as const;
const FRAME_SAMPLE_CAP = 5000;

function browserScheduler(): StabilityScheduler {
  const channel = new MessageChannel();
  const queue: (() => void)[] = [];
  channel.port1.onmessage = () => {
    for (const callback of queue.splice(0)) callback();
  };
  return {
    frame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (id) => cancelAnimationFrame(id),
    afterPaint: (callback) => {
      queue.push(callback);
      channel.port2.postMessage(null);
    },
    now: () => performance.now(),
    dispose: () => {
      queue.length = 0;
      channel.port1.close();
    },
  };
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

export function describeStabilityTarget(element: Element): string {
  const classes = Array.from(element.classList).slice(0, 2).map((name) => `.${name}`).join('');
  const turn = element.closest<HTMLElement>('[data-turn-id]')?.dataset.turnId;
  return `${element.tagName.toLowerCase()}${classes}${turn ? ` turn=${turn}` : ''}`;
}

export function createStabilityProbe(scroller: HTMLElement, options: StabilityProbeOptions = {}): StabilityProbe {
  const inputQuietMs = options.inputQuietMs ?? 150;
  const scrollChainMs = options.scrollChainMs ?? 50;
  const tolerance = options.tolerancePx ?? 1;
  const readingLine = options.readingLine ?? 0.25;
  const scheduler = options.scheduler ?? browserScheduler();
  const emit = options.onEvent;

  let report = emptyReport();
  let frameTimes: number[] = [];
  let lastFrameTime = 0;
  let writesThisFrame = 0;
  let lastInput = Number.NEGATIVE_INFINITY;
  let lastMotion = Number.NEGATIVE_INFINITY;
  let pointerHeld = false;
  let previous: { atBottom: boolean; target: Element | null; targetTop: number; row: Element | null; rowTop: number } | null = null;
  let frameId = 0;
  let stopped = false;

  function emptyReport(): StabilityReport {
    return {
      frames: 0, samples: 0, shifts: 0, maxShiftPx: 0, followLags: 0, blankFrames: 0, roLoops: 0,
      writes: 0, maxWritesPerFrame: 0, multiWriteFrames: 0, layoutShift: 0, longTasks: 0, longTaskMs: 0,
      frameP50Ms: 0, frameP95Ms: 0, frameMaxMs: 0,
    };
  }

  function markInput(): void {
    lastInput = scheduler.now();
    lastMotion = lastInput;
  }

  function onPointerDown(): void {
    pointerHeld = true;
    markInput();
  }

  function onPointerUp(): void {
    pointerHeld = false;
    markInput();
  }

  function onScroll(): void {
    const now = scheduler.now();
    if (now - lastInput <= inputQuietMs || now - lastMotion <= scrollChainMs) lastMotion = now;
  }

  function onError(event: ErrorEvent): void {
    if (!/ResizeObserver loop/.test(event.message ?? '')) return;
    report.roLoops++;
    emit?.({ kind: 'ro-loop' });
  }

  const scrollTopDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  const originalScrollTo = typeof scroller.scrollTo === 'function' ? (scroller.scrollTo.bind(scroller) as unknown as ScrollMethod) : undefined;
  const originalScrollBy = typeof scroller.scrollBy === 'function' ? (scroller.scrollBy.bind(scroller) as unknown as ScrollMethod) : undefined;

  function countWrite(before: number): void {
    if (scrollTopDescriptor?.get?.call(scroller) === before) return;
    report.writes++;
    writesThisFrame++;
  }

  const descriptor = scrollTopDescriptor;
  if (descriptor?.get && descriptor.set) {
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get() { return descriptor.get!.call(scroller) as number; },
      set(value: number) {
        const before = descriptor.get!.call(scroller) as number;
        descriptor.set!.call(scroller, value);
        countWrite(before);
      },
    });
  }

  function wrapScroll(original: ScrollMethod | undefined): ScrollMethod | undefined {
    if (original === undefined) return undefined;
    return (...args: unknown[]) => {
      const before = scroller.scrollTop;
      original(...args);
      countWrite(before);
    };
  }

  const wrappedScrollTo = wrapScroll(originalScrollTo);
  const wrappedScrollBy = wrapScroll(originalScrollBy);
  if (wrappedScrollTo) Object.defineProperty(scroller, 'scrollTo', { configurable: true, value: wrappedScrollTo });
  if (wrappedScrollBy) Object.defineProperty(scroller, 'scrollBy', { configurable: true, value: wrappedScrollBy });

  const observers: PerformanceObserver[] = [];
  const supported = typeof PerformanceObserver === 'undefined' ? [] : (PerformanceObserver.supportedEntryTypes ?? []);
  if (supported.includes('layout-shift')) {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as LayoutShiftEntry[]) {
        if (!entry.hadRecentInput) report.layoutShift += entry.value;
      }
    });
    observer.observe({ type: 'layout-shift' });
    observers.push(observer);
  }
  if (supported.includes('longtask')) {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        report.longTasks++;
        report.longTaskMs += entry.duration;
      }
    });
    observer.observe({ type: 'longtask' });
    observers.push(observer);
  }

  function isContainer(element: Element): boolean {
    return !element.hasAttribute('data-turn-id') && element.querySelector('[data-turn-id]') !== null;
  }

  function pickTarget(rect: DOMRect, clientHeight: number): Element | null {
    const y = rect.top + clientHeight * readingLine;
    for (const fraction of [0.5, 0.25, 0.75]) {
      let element = document.elementFromPoint(rect.left + rect.width * fraction, y);
      if (!element || element === scroller || !scroller.contains(element)) continue;
      if (options.placeholderSelector && element.closest(options.placeholderSelector)) continue;
      while (element && element !== scroller && element.getBoundingClientRect().height === 0) {
        element = element.parentElement;
      }
      if (element && element !== scroller && !isContainer(element)) return element;
    }
    return null;
  }

  function checkBlank(rect: DOMRect, clientHeight: number): void {
    if (!options.placeholderSelector) return;
    const top = rect.top;
    const bottom = rect.top + clientHeight;
    for (const placeholder of scroller.querySelectorAll(options.placeholderSelector)) {
      const box = placeholder.getBoundingClientRect();
      const visible = Math.min(box.bottom, bottom) - Math.max(box.top, top);
      if (visible > tolerance) {
        report.blankFrames++;
        emit?.({ kind: 'blank', height: Math.round(visible) });
        return;
      }
    }
  }

  function sample(): void {
    if (stopped || !scroller.isConnected) return;
    report.samples++;
    const now = scheduler.now();
    const rect = scroller.getBoundingClientRect();
    const { scrollTop, scrollHeight, clientHeight } = scroller;
    const gap = scrollHeight - scrollTop - clientHeight;
    const quiet = !pointerHeld && now - lastInput > inputQuietMs && now - lastMotion > scrollChainMs;
    const tracked = previous?.target?.isConnected ? previous.target : previous?.row?.isConnected ? previous.row : null;
    if (previous && quiet && tracked) {
      const delta = tracked.getBoundingClientRect().top - rect.top - (tracked === previous.target ? previous.targetTop : previous.rowTop);
      const moved = Math.abs(delta) > tolerance;
      const leftBottom = gap > tolerance;
      if (previous.atBottom ? moved && leftBottom : moved) {
        report.shifts++;
        report.maxShiftPx = Math.max(report.maxShiftPx, Math.abs(delta));
        emit?.({ kind: 'shift', atBottom: previous.atBottom, delta: Math.round(delta), target: describeStabilityTarget(tracked) });
      } else if (previous.atBottom && leftBottom) {
        report.followLags++;
      }
    }
    checkBlank(rect, clientHeight);
    const target = pickTarget(rect, clientHeight);
    const row = target?.closest('[data-turn-id]') ?? null;
    previous = {
      atBottom: gap <= tolerance,
      target,
      targetTop: target ? target.getBoundingClientRect().top - rect.top : 0,
      row,
      rowTop: row ? row.getBoundingClientRect().top - rect.top : 0,
    };
  }

  function tick(time: number): void {
    if (stopped) return;
    report.frames++;
    if (lastFrameTime) {
      frameTimes.push(time - lastFrameTime);
      if (frameTimes.length > FRAME_SAMPLE_CAP) frameTimes = frameTimes.slice(-FRAME_SAMPLE_CAP);
    }
    lastFrameTime = time;
    if (writesThisFrame > 1) {
      report.multiWriteFrames++;
      emit?.({ kind: 'multi-write', writes: writesThisFrame });
    }
    report.maxWritesPerFrame = Math.max(report.maxWritesPerFrame, writesThisFrame);
    writesThisFrame = 0;
    scheduler.afterPaint(sample);
    frameId = scheduler.frame(tick);
  }

  for (const type of INPUT_EVENTS) {
    window.addEventListener(type, type === 'pointerdown' ? onPointerDown : markInput, { capture: true, passive: true });
  }
  window.addEventListener('pointerup', onPointerUp, { capture: true, passive: true });
  window.addEventListener('pointercancel', onPointerUp, { capture: true, passive: true });
  window.addEventListener('error', onError);
  scroller.addEventListener('scroll', onScroll, { passive: true });
  frameId = scheduler.frame(tick);

  return {
    report() {
      const sorted = [...frameTimes].sort((a, b) => a - b);
      return {
        ...report,
        frameP50Ms: percentile(sorted, 0.5),
        frameP95Ms: percentile(sorted, 0.95),
        frameMaxMs: sorted.at(-1) ?? 0,
      };
    },
    reset() {
      report = emptyReport();
      frameTimes = [];
      lastFrameTime = 0;
      writesThisFrame = 0;
      previous = null;
    },
    markInput,
    stop() {
      if (stopped) return;
      stopped = true;
      scheduler.cancelFrame(frameId);
      scheduler.dispose?.();
      for (const observer of observers) observer.disconnect();
      for (const type of INPUT_EVENTS) {
        window.removeEventListener(type, type === 'pointerdown' ? onPointerDown : markInput, { capture: true });
      }
      window.removeEventListener('pointerup', onPointerUp, { capture: true });
      window.removeEventListener('pointercancel', onPointerUp, { capture: true });
      window.removeEventListener('error', onError);
      scroller.removeEventListener('scroll', onScroll);
      Reflect.deleteProperty(scroller, 'scrollTop');
      if (wrappedScrollTo) Reflect.deleteProperty(scroller, 'scrollTo');
      if (wrappedScrollBy) Reflect.deleteProperty(scroller, 'scrollBy');
    },
  };
}
