import type { Component, TUI } from '@moonshot-ai/pi-tui';
import { TuiAltScreen } from '@moonshot-ai/pi-tui';

export type ScreenTakeover =
  | { readonly kind: 'children'; readonly children: readonly Component[] }
  | { readonly kind: 'root'; readonly root: Component | undefined };

const activeTakeovers = new WeakMap<TUI, Set<ScreenTakeover>>();

export function beginScreenTakeover(ui: TUI, viewer: Component): ScreenTakeover {
  const takeover: ScreenTakeover =
    ui instanceof TuiAltScreen
      ? (() => {
          const root = ui.getLayoutRoot();
          ui.setLayoutRoot(viewer);
          return { kind: 'root', root };
        })()
      : (() => {
          const children = [...ui.children];
          ui.clear();
          ui.addChild(viewer);
          return { kind: 'children', children };
        })();
  let tracked = activeTakeovers.get(ui);
  if (tracked === undefined) {
    tracked = new Set();
    activeTakeovers.set(ui, tracked);
  }
  tracked.add(takeover);
  return takeover;
}

export function endScreenTakeover(ui: TUI, takeover: ScreenTakeover): void {
  const tracked = activeTakeovers.get(ui);
  if (tracked === undefined || !tracked.delete(takeover)) return;
  if (tracked.size === 0) {
    activeTakeovers.delete(ui);
  }
  if (takeover.kind === 'root') {
    if (ui instanceof TuiAltScreen) ui.setLayoutRoot(takeover.root);
    return;
  }
  ui.clear();
  for (const child of takeover.children) ui.addChild(child);
}

export function hasActiveScreenTakeover(ui: TUI): boolean {
  return (activeTakeovers.get(ui)?.size ?? 0) > 0;
}
