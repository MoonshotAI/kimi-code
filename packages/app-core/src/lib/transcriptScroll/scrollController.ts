import { nextJumpPillVisible } from '../followScroll';
import { createDomAnchors, resolvedExactly, ROW_KEY_ATTRIBUTE, type AnchorCandidate, type AnchorPath, type PickOptions } from './anchor';
import { isUnexpectedScroll, readScrollIntent } from './intent';
import type { LayoutModel } from './layoutModel';

export const FOLLOW_THRESHOLD = 24;
export const SCROLL_ANIMATION_MS = 240;
export const HOLD_MS = 200;

export type ScrollAlign = 'start' | 'center';

export type ScrollMode =
  | { kind: 'follow' }
  | { kind: 'anchored'; anchor: AnchorPath; offset: number; rowOffset?: number }
  | { kind: 'navigating'; target: AnchorPath; align: ScrollAlign; shift?: number; animation?: boolean };

export type AuxKind = 'tail' | 'dock' | 'content';

export interface NavigateOptions {
  align?: ScrollAlign;
  smooth?: boolean;
  shift?: number;
}

export interface RestoreOptions {
  defer?: boolean;
}

export type ScrollSnapshot =
  | { mode: 'follow' }
  | { mode: 'anchored'; anchor: AnchorPath; offset: number; rowOffset?: number };

export type ScrollWriteReason =
  | 'resize'
  | 'follow'
  | 'navigate'
  | 'animate'
  | 'restore'
  | 'drag-end'
  | 'touch-end'
  | 'scroll-end'
  | 'sync';

export interface TranscriptLayout {
  dockHeight: number;
}

export interface ScrollAdapter {
  scroller: HTMLElement;
  model: LayoutModel;
  resolveAnchor(path: AnchorPath): HTMLElement | null;
  pickAnchor(viewTop: number, options?: PickOptions): AnchorCandidate | null;
  pathOf(el: Element): AnchorPath | null;
  rowTop(key: string): number | null;
  applyLayout(layout: TranscriptLayout): void;
}

export interface ScrollState {
  mode: ScrollMode;
  following: boolean;
  showJump: boolean;
  activeRowKey: string | null;
}

export interface ResizeBoxSize {
  blockSize: number;
  inlineSize: number;
}

export interface ResizeEntryLike {
  target: Element;
  borderBoxSize?: readonly ResizeBoxSize[];
  contentBoxSize?: readonly ResizeBoxSize[];
  contentRect: { width: number; height: number };
}

export interface ResizeObserverLike {
  observe(target: Element, options?: ResizeObserverOptions): void;
  unobserve(target: Element): void;
  disconnect(): void;
}

export interface ScrollOptions {
  followThreshold: number;
  animationMs: number;
  createResizeObserver: (callback: (entries: readonly ResizeEntryLike[]) => void) => ResizeObserverLike;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (handle: number) => void;
  now: () => number;
  reducedMotion: () => boolean;
  fontScale: () => string;
  supportsScrollEnd: boolean;
  onWrite?: (top: number, reason: ScrollWriteReason) => void;
  onChange?: (state: Readonly<ScrollState>) => void;
}

export interface ScrollController {
  readonly state: Readonly<ScrollState>;
  observeRow(key: string, el: HTMLElement | null): void;
  observeAux(kind: AuxKind, el: HTMLElement | null, id?: string): void;
  onScroll(): void;
  onInput(event: Event): void;
  sync(): void;
  follow(options?: { smooth?: boolean }): void;
  navigate(path: AnchorPath, options?: NavigateOptions): Promise<void>;
  hold(el: HTMLElement, ms?: number): void;
  snapshot(): ScrollSnapshot;
  restore(snapshot: ScrollSnapshot | null, options?: RestoreOptions): void;
  dispose(): void;
}

export interface DomScrollAdapterOptions {
  scroller: HTMLElement;
  model: LayoutModel;
  list: () => HTMLElement | null;
  applyLayout: (layout: TranscriptLayout) => void;
}

export function createDomScrollAdapter(options: DomScrollAdapterOptions): ScrollAdapter {
  const { scroller, model } = options;
  const anchors = createDomAnchors(scroller);
  return {
    scroller,
    model,
    resolveAnchor: anchors.resolve,
    pickAnchor(viewTop, pickOptions) {
      const candidate = anchors.pick(viewTop, pickOptions);
      if (candidate && candidate.offset <= 0) return candidate;
      const list = options.list();
      if (!list) return candidate;
      const listTop = list.getBoundingClientRect().top;
      const y = viewTop - listTop;
      if (y < 0 || y >= model.total()) return candidate;
      const index = model.indexAt(y);
      const key = model.keyAt(index);
      if (key === undefined || candidate?.path.row === key) return candidate;
      const offset = listTop + model.top(index) - viewTop;
      return { path: { row: key }, el: list, offset, rowOffset: offset };
    },
    pathOf: anchors.pathOf,
    rowTop(key) {
      const index = model.indexOf(key);
      const list = options.list();
      if (index === undefined || !list) return null;
      const listTop = list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      return listTop + model.top(index);
    },
    applyLayout: options.applyLayout,
  };
}

function defaultOptions(): ScrollOptions {
  return {
    followThreshold: FOLLOW_THRESHOLD,
    animationMs: SCROLL_ANIMATION_MS,
    createResizeObserver: callback => new ResizeObserver(entries => callback(entries)),
    requestFrame: callback => requestAnimationFrame(callback),
    cancelFrame: handle => cancelAnimationFrame(handle),
    now: () => performance.now(),
    reducedMotion: () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
    fontScale: () => (typeof document === 'undefined' ? undefined : document.documentElement.dataset['fontScale']) ?? 'medium',
    supportsScrollEnd: typeof window !== 'undefined' && 'onscrollend' in window,
  };
}

function blockSize(entry: ResizeEntryLike): number {
  return entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
}

function inlineSize(entry: ResizeEntryLike): number {
  return entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
}

function easeOutCubic(progress: number): number {
  return 1 - (1 - progress) ** 3;
}

type Target = { kind: 'row'; key: string } | { kind: AuxKind };
type Animation = { frame: number };

export function createScrollController(adapter: ScrollAdapter, overrides: Partial<ScrollOptions> = {}): ScrollController {
  const options: ScrollOptions = { ...defaultOptions(), ...overrides };
  const { scroller, model } = adapter;
  const state: ScrollState = { mode: { kind: 'follow' }, following: true, showJump: false, activeRowKey: null };
  let emitted = { ...state };
  const rows = new Map<string, HTMLElement>();
  const targets = new Map<Element, Target>();
  const retiring = new Set<Element>();
  const aux = new Map<string, HTMLElement>();
  let dockHeight = 0;
  let expectedTop = scroller.scrollTop;
  let held: { el: HTMLElement; offset: number; until: number } | null = null;
  let holdFrame = 0;
  let dragging = false;
  let touchActive = false;
  let touching = false;
  let touchScrolled = false;
  let touchSettled = false;
  let scrollInput = false;
  let restoring = false;
  let animation: Animation | null = null;
  let settleNavigation: (() => void) | null = null;
  let disposed = false;

  const observer = options.createResizeObserver(onResize);
  observer.observe(scroller);

  function viewTop(): number {
    return scroller.getBoundingClientRect().top;
  }

  function maxTop(): number {
    return Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  }

  function docTop(el: Element): number {
    return scroller.scrollTop + el.getBoundingClientRect().top - viewTop();
  }

  function anchoredAt(anchor: AnchorPath, offset: number, rowOffset?: number): ScrollMode {
    let resolvedRowOffset = rowOffset;
    if (resolvedRowOffset === undefined) {
      const row = anchor.block === undefined && anchor.child === undefined ? null : adapter.resolveAnchor({ row: anchor.row });
      resolvedRowOffset = row ? row.getBoundingClientRect().top - viewTop() : undefined;
    }
    return resolvedRowOffset === undefined
      ? { kind: 'anchored', anchor, offset }
      : { kind: 'anchored', anchor, offset, rowOffset: resolvedRowOffset };
  }

  function setMode(mode: ScrollMode): void {
    state.mode = mode;
    state.following = mode.kind === 'follow';
  }

  function emit(): void {
    if (
      emitted.mode === state.mode &&
      emitted.following === state.following &&
      emitted.showJump === state.showJump &&
      emitted.activeRowKey === state.activeRowKey
    ) return;
    emitted = { ...state };
    options.onChange?.(state);
  }

  function updateIndicators(): void {
    state.showJump = nextJumpPillVisible(state.showJump, maxTop() - scroller.scrollTop, scroller.clientHeight);
    const middle = adapter.pickAnchor(viewTop() + scroller.clientHeight / 2, { rowOnly: true });
    state.activeRowKey = middle?.path.row ?? null;
  }

  function finishNavigation(): void {
    const settle = settleNavigation;
    settleNavigation = null;
    settle?.();
  }

  function cancelAnimation(): void {
    if (!animation) return;
    options.cancelFrame(animation.frame);
    animation = null;
  }

  function anchorHere(): void {
    held = null;
    const candidate = adapter.pickAnchor(viewTop());
    if (candidate) setMode(anchoredAt(candidate.path, candidate.offset, candidate.rowOffset));
    else if (state.mode.kind === 'navigating') setMode({ kind: 'follow' });
  }

  function interrupt(): void {
    cancelAnimation();
    finishNavigation();
    anchorHere();
  }

  function write(top: number, reason: ScrollWriteReason): void {
    const next = Math.min(Math.max(0, top), maxTop());
    if (Math.abs(next - scroller.scrollTop) <= 0.5) return;
    scroller.scrollTop = next;
    expectedTop = scroller.scrollTop;
    scrollInput = false;
    options.onWrite?.(expectedTop, reason);
  }

  function alignOffset(height: number, align: ScrollAlign): number {
    if (align === 'start') return 0;
    const viewport = scroller.clientHeight;
    return height >= viewport ? 0 : (viewport - height) / 2;
  }

  function navigationTarget(mode: Extract<ScrollMode, { kind: 'navigating' }>, settle: boolean): number | null {
    const shift = mode.shift ?? 0;
    const el = adapter.resolveAnchor(mode.target);
    if (el) {
      const offset = alignOffset(el.getBoundingClientRect().height, mode.align) - shift;
      const top = docTop(el) - offset;
      if (settle) {
        setMode(anchoredAt(mode.target, offset));
        finishNavigation();
      }
      return top;
    }
    const rowTop = adapter.rowTop(mode.target.row);
    if (rowTop === null) {
      if (settle) {
        finishNavigation();
        anchorHere();
      }
      return null;
    }
    const index = model.indexOf(mode.target.row);
    return rowTop - alignOffset(index === undefined ? 0 : model.height(index), mode.align) + shift;
  }

  function solve(): number | null {
    const mode = state.mode;
    if (mode.kind === 'follow') return maxTop();
    if (mode.kind === 'navigating') return navigationTarget(mode, true);
    if (held) {
      if (held.el.isConnected && scroller.contains(held.el)) return docTop(held.el) - held.offset;
      held = null;
    }
    const el = adapter.resolveAnchor(mode.anchor);
    if (el) {
      if (mode.rowOffset === undefined || (mode.anchor.block === undefined && mode.anchor.child === undefined)) return docTop(el) - mode.offset;
      const row = el.closest<HTMLElement>(`[${ROW_KEY_ATTRIBUTE}]`) ?? el;
      if (!resolvedExactly(el, mode.anchor)) return docTop(row) - mode.rowOffset;
      const top = docTop(el) - mode.offset;
      mode.rowOffset = docTop(row) - top;
      return top;
    }
    const rowTop = adapter.rowTop(mode.anchor.row);
    return rowTop === null ? null : rowTop - (mode.rowOffset ?? mode.offset);
  }

  function correct(reason: ScrollWriteReason): void {
    if (disposed) return;
    if (isUnexpectedScroll(scroller.scrollTop, expectedTop) && !adoptClamp()) handleScroll(true);
    if (!animation && !dragging && !touching) {
      const wasRestoring = restoring;
      restoring = false;
      const top = solve();
      if (top !== null) {
        write(top, reason);
        if (!wasRestoring) adoptTopClamp(top);
      }
    }
    updateIndicators();
    emit();
  }

  function adoptTopClamp(top: number): void {
    const delta = scroller.scrollTop - top;
    if (top >= 0 || delta <= 0.5) return;
    if (held) {
      held.offset -= delta;
      return;
    }
    const mode = state.mode;
    if (mode.kind !== 'anchored') return;
    mode.offset -= delta;
    if (mode.rowOffset !== undefined) mode.rowOffset -= delta;
  }

  function adoptClamp(): boolean {
    if ((!restoring && state.mode.kind !== 'navigating' && !animation) || scrollInput || dragging || touching) return false;
    expectedTop = scroller.scrollTop;
    return true;
  }

  function pendingShift(): number {
    const mode = state.mode;
    if (dragging || touching || mode.kind !== 'anchored') return 0;
    if (!held && !adapter.resolveAnchor(mode.anchor)) return 0;
    const target = solve();
    return target === null ? 0 : target - expectedTop;
  }

  function followClamp(top: number): boolean {
    return state.mode.kind === 'follow' && !scrollInput && !touching && expectedTop - top <= options.followThreshold;
  }

  function handleScroll(layout = false): void {
    const top = scroller.scrollTop;
    if (!isUnexpectedScroll(top, expectedTop) || adoptClamp()) return;
    if (touching) {
      touchScrolled = true;
      touchSettled = false;
    }
    const max = maxTop();
    if (top < expectedTop && !dragging && (top >= max - 1 || (layout && followClamp(top)))) {
      expectedTop = top;
      return;
    }
    const shift = pendingShift();
    const direction = top > expectedTop ? 1 : -1;
    expectedTop = top;
    scrollInput = false;
    if (animation || state.mode.kind === 'navigating') {
      cancelAnimation();
      finishNavigation();
    }
    held = null;
    if (Math.abs(shift) > 0.5) write(top + shift, 'resize');
    const distance = maxTop() - scroller.scrollTop;
    if (state.mode.kind === 'follow') {
      if (direction < 0 || distance > options.followThreshold) anchorHere();
    } else if (direction > 0 && distance <= options.followThreshold) {
      setMode({ kind: 'follow' });
    } else {
      anchorHere();
    }
  }

  function onScroll(): void {
    if (disposed) return;
    handleScroll();
    updateIndicators();
    emit();
  }

  function onInput(event: Event): void {
    if (disposed) return;
    const intent = readScrollIntent(event, scroller);
    if (!intent) return;
    if (intent.kind === 'scroll' || intent.kind === 'drag-start' || intent.kind === 'touch-start') scrollInput = true;
    switch (intent.kind) {
      case 'scroll':
        if (intent.source === 'touch') touching = touchActive = true;
        if (animation || state.mode.kind === 'navigating') interrupt();
        else if (intent.direction < 0 && state.mode.kind === 'follow' && maxTop() > 1) anchorHere();
        break;
      case 'drag-start':
        dragging = true;
        if (animation || state.mode.kind === 'navigating') interrupt();
        else if (state.mode.kind === 'follow') anchorHere();
        break;
      case 'drag-end':
        if (!dragging) return;
        dragging = false;
        correct('drag-end');
        return;
      case 'touch-start':
        touching = touchActive = true;
        touchScrolled = touchSettled = false;
        if (animation || state.mode.kind === 'navigating') interrupt();
        break;
      case 'touch-end':
        if (!touchActive) return;
        touchActive = false;
        if (!touchScrolled || touchSettled || !options.supportsScrollEnd) {
          touching = false;
          correct('touch-end');
          return;
        }
        break;
      case 'scroll-end':
        if (!touching) return;
        if (touchActive) {
          touchSettled = true;
          return;
        }
        touching = false;
        correct('scroll-end');
        return;
    }
    emit();
  }

  function onResize(entries: readonly ResizeEntryLike[]): void {
    if (disposed) return;
    const widthSource = aux.get('content') ?? scroller;
    let width: number | undefined;
    for (const entry of entries) if (entry.target === widthSource) width = inlineSize(entry);
    model.setEnvironment(width === undefined ? { fontScale: options.fontScale() } : { width, fontScale: options.fontScale() });
    for (const entry of entries) {
      const target = targets.get(entry.target);
      if (!target) continue;
      if (retiring.has(entry.target)) {
        if (!entry.target.isConnected) {
          observer.unobserve(entry.target);
          retiring.delete(entry.target);
          targets.delete(entry.target);
        }
        continue;
      }
      if (target.kind === 'row') {
        const height = blockSize(entry);
        if (height > 0) model.measure(target.key, height);
      }
      else if (target.kind === 'dock') dockHeight = blockSize(entry);
    }
    model.refreshEstimates();
    adapter.applyLayout({ dockHeight });
    correct('resize');
  }

  function sync(): void {
    correct('sync');
  }

  function animate(target: () => number | null, done: () => void): void {
    cancelAnimation();
    const from = scroller.scrollTop;
    const start = options.now();
    const run: Animation = { frame: 0 };
    const tick = (): void => {
      if (animation !== run || disposed) return;
      const progress = options.animationMs > 0 ? Math.min(1, (options.now() - start) / options.animationMs) : 1;
      const live = target();
      if (live !== null) write(progress >= 1 ? live : from + (live - from) * easeOutCubic(progress), 'animate');
      if (live === null || progress >= 1) {
        animation = null;
        done();
        updateIndicators();
        emit();
        return;
      }
      run.frame = options.requestFrame(tick);
    };
    animation = run;
    run.frame = options.requestFrame(tick);
  }

  function observeRow(key: string, el: HTMLElement | null): void {
    const previous = rows.get(key);
    if (previous === el) return;
    if (previous) retiring.add(previous);
    if (!el) {
      rows.delete(key);
      return;
    }
    rows.set(key, el);
    targets.set(el, { kind: 'row', key });
    retiring.delete(el);
    observer.observe(el, { box: 'border-box' });
  }

  function observeAux(kind: AuxKind, el: HTMLElement | null, id?: string): void {
    const slot = id === undefined ? kind : `${kind}:${id}`;
    const previous = aux.get(slot) ?? null;
    if (previous === el) return;
    if (previous) {
      observer.unobserve(previous);
      targets.delete(previous);
      aux.delete(slot);
    }
    if (el) {
      aux.set(slot, el);
      targets.set(el, { kind });
      observer.observe(el, { box: 'border-box' });
    } else if (kind === 'dock') {
      dockHeight = 0;
      adapter.applyLayout({ dockHeight });
      correct('resize');
    }
  }

  function abandonTouch(): void {
    touching = touchActive = false;
  }

  function follow(opts: { smooth?: boolean } = {}): void {
    if (disposed) return;
    abandonTouch();
    cancelAnimation();
    finishNavigation();
    held = null;
    setMode({ kind: 'follow' });
    if (opts.smooth && !options.reducedMotion()) {
      animate(() => (state.mode.kind === 'follow' ? maxTop() : null), () => {});
      emit();
    } else {
      correct('follow');
    }
  }

  function navigate(path: AnchorPath, opts: NavigateOptions = {}): Promise<void> {
    if (disposed) return Promise.resolve();
    abandonTouch();
    cancelAnimation();
    finishNavigation();
    held = null;
    if (!adapter.resolveAnchor(path) && model.indexOf(path.row) === undefined) return Promise.resolve();
    const smooth = opts.smooth === true && !options.reducedMotion();
    const mode: ScrollMode = {
      kind: 'navigating',
      target: path,
      align: opts.align ?? 'start',
      ...(opts.shift ? { shift: opts.shift } : {}),
      ...(smooth ? { animation: true } : {}),
    };
    setMode(mode);
    const done = new Promise<void>(resolve => {
      settleNavigation = resolve;
    });
    if (smooth) {
      animate(
        () => (state.mode === mode ? navigationTarget(mode, false) : null),
        () => {
          if (state.mode === mode) navigationTarget(mode, true);
          finishNavigation();
        },
      );
      emit();
    } else {
      correct('navigate');
    }
    return done;
  }

  function hold(el: HTMLElement, ms = HOLD_MS): void {
    if (disposed) return;
    const path = adapter.pathOf(el);
    if (!path) return;
    cancelAnimation();
    finishNavigation();
    const top = viewTop();
    const resolved = adapter.resolveAnchor(path) ?? el;
    setMode(anchoredAt(path, resolved.getBoundingClientRect().top - top));
    held = { el, offset: el.getBoundingClientRect().top - top, until: options.now() + ms };
    if (!holdFrame) holdFrame = options.requestFrame(releaseHold);
    emit();
  }

  function releaseHold(): void {
    holdFrame = 0;
    if (disposed || !held) return;
    if (options.now() < held.until) {
      holdFrame = options.requestFrame(releaseHold);
      return;
    }
    held = null;
    if (state.mode.kind !== 'anchored' || dragging || touching || maxTop() - scroller.scrollTop > options.followThreshold) return;
    setMode({ kind: 'follow' });
    correct('follow');
  }

  function snapshot(): ScrollSnapshot {
    const mode = state.mode;
    if (mode.kind === 'follow') return { mode: 'follow' };
    if (mode.kind === 'anchored') {
      const current = anchoredAt(mode.anchor, mode.offset) as Extract<ScrollMode, { kind: 'anchored' }>;
      const rowOffset = current.rowOffset ?? mode.rowOffset;
      return { mode: 'anchored', anchor: { ...mode.anchor }, offset: mode.offset, ...(rowOffset === undefined ? {} : { rowOffset }) };
    }
    const candidate = adapter.pickAnchor(viewTop());
    if (!candidate) return { mode: 'follow' };
    return { mode: 'anchored', anchor: candidate.path, offset: candidate.offset, ...(candidate.rowOffset === undefined ? {} : { rowOffset: candidate.rowOffset }) };
  }

  function restore(next: ScrollSnapshot | null, opts: RestoreOptions = {}): void {
    if (disposed) return;
    cancelAnimation();
    finishNavigation();
    held = null;
    setMode(!next || next.mode === 'follow' ? { kind: 'follow' } : anchoredAt({ ...next.anchor }, next.offset, next.rowOffset));
    expectedTop = scroller.scrollTop;
    scrollInput = false;
    restoring = opts.defer === true;
    if (opts.defer) emit();
    else correct('restore');
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    cancelAnimation();
    if (holdFrame) options.cancelFrame(holdFrame);
    finishNavigation();
    observer.disconnect();
    rows.clear();
    targets.clear();
    retiring.clear();
    aux.clear();
  }

  return {
    get state() {
      return state;
    },
    observeRow,
    observeAux,
    onScroll,
    onInput,
    sync,
    follow,
    navigate,
    hold,
    snapshot,
    restore,
    dispose,
  };
}
