// packages/app-client/src/composables/usePageTitle.ts
// Page title (app name only). The session title and workspace name are
// intentionally excluded so the window / tab title stays stable.
//
// On web an animated spinner prefixes the title while the agent is running so
// users can see activity at a glance in a browser tab. On desktop that spinner
// leaks into the macOS Dock menu and window chrome, so the title stays static;
// running state is already surfaced by the in-app activity indicator and tray
// attention.

import { computed, onUnmounted, ref, watch, watchEffect, type Ref } from 'vue';
import { isDesktop } from '@moonshot-ai/app-core/lib';

export interface UsePageTitleOptions {
  running: Ref<boolean>;
  /** Base title (default 'Kimi Code'; the web app passes 'Kimi Code Web'). */
  title?: string;
}

export function usePageTitle({ running, title = 'Kimi Code' }: UsePageTitleOptions): void {
  if (isDesktop) {
    watchEffect(() => {
      if (typeof document !== 'undefined') document.title = title;
    });
    return;
  }

  const SPINNER_FRAMES = ['◐', '◓', '◑', '◒'];
  const spinnerFrame = ref(0);
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;

  function startSpinner(): void {
    if (spinnerTimer !== null) return;
    spinnerFrame.value = 0;
    spinnerTimer = setInterval(() => {
      spinnerFrame.value = (spinnerFrame.value + 1) % SPINNER_FRAMES.length;
    }, 250);
  }

  function stopSpinner(): void {
    if (spinnerTimer !== null) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
    spinnerFrame.value = 0;
  }

  watch(running, (isRunning) => {
    if (isRunning) startSpinner();
    else stopSpinner();
  }, { immediate: true });

  const pageTitle = computed<string>(() => {
    const prefix = running.value ? `${SPINNER_FRAMES[spinnerFrame.value]} ` : '';
    return `${prefix}${title}`;
  });
  watchEffect(() => {
    if (typeof document !== 'undefined') document.title = pageTitle.value;
  });

  onUnmounted(() => {
    stopSpinner();
  });
}
