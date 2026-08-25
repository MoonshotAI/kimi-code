// apps/desktop/src/renderer/lib/prPreview.ts
// Desktop-only PR preview (dev builds / Kimi Code Canary): the main process
// builds a code-app PR/branch/sha's renderer in an isolated git worktree and
// swaps this window onto it (main/pr-preview.ts). The preload bridge exposes
// it as `window.kimiDesktop.prPreview*`; plain web has no bridge and stable
// packaged builds answer getState with null — both mean "feature unavailable"
// and the entry point stays hidden (see docs/native-todos.md).
//

export type PrPreviewPhase = 'idle' | 'fetching' | 'installing' | 'building' | 'active' | 'error';

export interface PrPreviewState {
  phase: PrPreviewPhase;
  pr?: number;
  /** Raw ref of the current/last ref operation (branch/tag/sha), for retry. */
  refTarget?: string;
  /** Display label of the current/last operation (`#306` or the ref). */
  label?: string;
  message?: string;
  /** Live output tail of the in-flight stage (throttled pushes from main). */
  logTail?: string;
  /** PR whose build the window is actually serving right now, independent of
   *  the display phase (a failed rebuild keeps the previous preview serving). */
  servingPr?: number;
  /** servingPr 的 ref 版：正在服务的是一次 ref 预览时的展示标签。 */
  servingLabel?: string;
  /** Stage a stage failure came from, for the dialog's localized stage line. */
  errorStage?: 'fetch' | 'install' | 'build';
  /** The stage was killed by the no-output watchdog (not a plain failure). */
  errorHung?: boolean;
}

/** What to preview: a pull request, or a free-form git ref (branch/tag/sha). */
export type PrPreviewTarget = { kind: 'pr'; pr: number } | { kind: 'ref'; ref: string };

export interface PrPreviewRefList {
  prs: Array<{ number: number; title: string }>;
  branches: string[];
}

interface PrPreviewBridge {
  getPrPreviewState: () => Promise<PrPreviewState | null>;
  prPreviewStart: (target: number | PrPreviewTarget) => Promise<PrPreviewState>;
  prPreviewStop: () => Promise<PrPreviewState>;
  prPreviewCancel: () => Promise<PrPreviewState>;
  listPrPreviewRefs: () => Promise<PrPreviewRefList>;
  prPreviewCleanup: () => Promise<number>;
  onPrPreviewEvent: (cb: (state: PrPreviewState) => void) => () => void;
}

function bridge(): PrPreviewBridge | undefined {
  return (window as { kimiDesktop?: PrPreviewBridge }).kimiDesktop;
}

/** True only where the feature can actually run: desktop bridge present AND
 *  the preload carries the pr-preview methods (an older desktop build would
 *  have the bridge without them). Stable packaged builds are filtered out by
 *  the null getState response, which the caller probes once on mount. */
export function canUsePrPreview(): boolean {
  const b = bridge();
  return (
    b !== undefined &&
    typeof b.getPrPreviewState === 'function' &&
    typeof b.prPreviewStart === 'function' &&
    typeof b.prPreviewStop === 'function' &&
    typeof b.prPreviewCancel === 'function' &&
    typeof b.prPreviewCleanup === 'function' &&
    typeof b.onPrPreviewEvent === 'function'
  );
}

/** Current state; null = unavailable (stable packaged build) — hide the entry. */
export function getPrPreviewState(): Promise<PrPreviewState | null> {
  const b = bridge();
  if (b === undefined) return Promise.resolve(null);
  return b.getPrPreviewState();
}

function requireBridge(): PrPreviewBridge {
  const b = bridge();
  if (b === undefined) throw new Error('pr-preview: desktop bridge unavailable');
  return b;
}

export function startPrPreview(target: PrPreviewTarget): Promise<PrPreviewState> {
  return requireBridge().prPreviewStart(target);
}

export function stopPrPreview(): Promise<PrPreviewState> {
  return requireBridge().prPreviewStop();
}

export function cancelPrPreview(): Promise<PrPreviewState> {
  return requireBridge().prPreviewCancel();
}

/** Open PRs + remote branches for the picker; empty halves when unavailable
 *  (no bridge, or the older bridge without the method). */
export function listPrPreviewRefs(): Promise<PrPreviewRefList> {
  const b = bridge();
  if (b === undefined || typeof b.listPrPreviewRefs !== 'function') {
    return Promise.resolve({ prs: [], branches: [] });
  }
  return b.listPrPreviewRefs();
}

/** Remove every cached preview worktree except the served/in-flight ones;
 *  resolves with the number of removed dirs. */
export function cleanupPrPreviews(): Promise<number> {
  return requireBridge().prPreviewCleanup();
}

export function onPrPreviewEvent(cb: (state: PrPreviewState) => void): () => void {
  const b = bridge();
  if (b === undefined) return () => {};
  return b.onPrPreviewEvent(cb);
}
