/**
 * Mode-aware full-screen viewer takeover.
 *
 * In regular mode a viewer is mounted by snapshotting the root container's
 * children and swapping the viewer in. In fullscreen (alternate screen) the
 * root children are not painted at all — the layout root is — so the viewer
 * must become the layout root instead. Both shapes restore cleanly and nest
 * (a viewer opened from another viewer).
 */

import type { Component, TUI } from '@moonshot-ai/pi-tui';
import { TuiAltScreen } from '@moonshot-ai/pi-tui';

/** Restore data for a screen takeover; opaque to callers. */
export type ScreenTakeover =
  | { readonly kind: 'children'; readonly children: readonly Component[] }
  | { readonly kind: 'root'; readonly root: Component | undefined };

export function beginScreenTakeover(ui: TUI, viewer: Component): ScreenTakeover {
  if (ui instanceof TuiAltScreen) {
    const root = ui.getLayoutRoot();
    ui.setLayoutRoot(viewer);
    return { kind: 'root', root };
  }
  const children = [...ui.children];
  ui.clear();
  ui.addChild(viewer);
  return { kind: 'children', children };
}

export function endScreenTakeover(ui: TUI, takeover: ScreenTakeover): void {
  if (takeover.kind === 'root') {
    if (ui instanceof TuiAltScreen) ui.setLayoutRoot(takeover.root);
    return;
  }
  ui.clear();
  for (const child of takeover.children) ui.addChild(child);
}
