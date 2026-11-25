import type { Component, TUI } from '@moonshot-ai/pi-tui';
import { TuiAltScreen } from '@moonshot-ai/pi-tui';

import { ScreenTakeoverView } from '#/tui/components/chrome/screen-takeover-view';

export type ScreenTakeover =
  | { readonly kind: 'children'; readonly children: readonly Component[] }
  | {
      readonly kind: 'root';
      readonly root: Component | undefined;
      readonly viewer?: ScreenTakeoverView;
    };

export function beginScreenTakeover(ui: TUI, viewer: Component): ScreenTakeover {
  if (ui instanceof TuiAltScreen) {
    const root = ui.getLayoutRoot();
    if (root instanceof ScreenTakeoverView) root.setScrollbarsActive(false);
    if (viewer instanceof ScreenTakeoverView) viewer.setScrollbarsActive(true);
    ui.setLayoutRoot(viewer);
    return viewer instanceof ScreenTakeoverView
      ? { kind: 'root', root, viewer }
      : { kind: 'root', root };
  }
  const children = [...ui.children];
  ui.clear();
  ui.addChild(viewer);
  return { kind: 'children', children };
}

export function endScreenTakeover(ui: TUI, takeover: ScreenTakeover): void {
  if (takeover.kind === 'root') {
    takeover.viewer?.setScrollbarsActive(false);
    if (ui instanceof TuiAltScreen) {
      if (takeover.root instanceof ScreenTakeoverView) takeover.root.setScrollbarsActive(true);
      ui.setLayoutRoot(takeover.root);
    }
    return;
  }
  ui.clear();
  for (const child of takeover.children) ui.addChild(child);
}
