// apps/web/src/composables/usePageTitle.ts
// Static page title for the desktop app. The session title and workspace name
// are intentionally excluded so the window / Dock menu title stays stable.
//
// The web version prefixes an animated spinner while the agent is running so
// users can see activity at a glance in a browser tab. On desktop that spinner
// leaks into the macOS Dock menu and window chrome, so we keep the title
// static; running state is already surfaced by the in-app activity indicator
// and tray attention.

import { watchEffect, type Ref } from 'vue';

export interface UsePageTitleOptions {
  running: Ref<boolean>;
}

export function usePageTitle(_options: UsePageTitleOptions): void {
  watchEffect(() => {
    if (typeof document !== 'undefined') document.title = 'Kimi Code';
  });
}
