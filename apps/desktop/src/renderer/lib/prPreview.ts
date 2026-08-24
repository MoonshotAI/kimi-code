// apps/desktop/src/renderer/lib/prPreview.ts
// Desktop-only PR preview (dev builds): the main process builds a code-app
// PR's renderer in an isolated git worktree and swaps this window onto it
// (main/pr-preview.ts). The preload bridge exposes it as
// `window.kimiDesktop.prPreview*`; plain web has no bridge and packaged
// builds answer getState with null — both mean "feature unavailable" and the
// entry point stays hidden (see docs/native-todos.md).
//

export type PrPreviewPhase = 'idle' | 'fetching' | 'installing' | 'building' | 'active' | 'error';

export interface PrPreviewState {
  phase: PrPreviewPhase;
  pr?: number;
  message?: string;
  /** Live output tail of the in-flight stage (throttled pushes from main). */
  logTail?: string;
  /** PR whose build the window is actually serving right now, independent of
   *  the display phase (a failed rebuild keeps the previous preview serving). */
  servingPr?: number;
  /** Stage a stage failure came from, for the dialog's localized stage line. */
  errorStage?: 'fetch' | 'install' | 'build';
  /** The stage was killed by the no-output watchdog (not a plain failure). */
  errorHung?: boolean;
}

interface PrPreviewBridge {
  getPrPreviewState: () => Promise<PrPreviewState | null>;
  prPreviewStart: (pr: number) => Promise<PrPreviewState>;
  prPreviewStop: () => Promise<PrPreviewState>;
  prPreviewCancel: () => Promise<PrPreviewState>;
  prPreviewCleanup: () => Promise<number>;
  onPrPreviewEvent: (cb: (state: PrPreviewState) => void) => () => void;
}

function bridge(): PrPreviewBridge | undefined {
  return (window as { kimiDesktop?: PrPreviewBridge }).kimiDesktop;
}

/** True only where the feature can actually run: desktop bridge present AND
 *  the preload carries the pr-preview methods (an older desktop build would
 *  have the bridge without them). Packaged builds are filtered out by the
 *  null getState response, which the caller probes once on mount. */
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

/** Current state; null = unavailable (packaged build) — hide the entry. */
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

export function startPrPreview(pr: number): Promise<PrPreviewState> {
  return requireBridge().prPreviewStart(pr);
}

export function stopPrPreview(): Promise<PrPreviewState> {
  return requireBridge().prPreviewStop();
}

export function cancelPrPreview(): Promise<PrPreviewState> {
  return requireBridge().prPreviewCancel();
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
