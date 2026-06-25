// apps/kimi-web/src/composables/usePageTitle.ts
// Static page title (app name only). The session title and workspace name are
// intentionally excluded so the tab title stays stable.
// Prefix an animated spinner when the agent is running so users can see activity
// at a glance.

import { computed, onUnmounted, ref, watch, watchEffect, type Ref } from 'vue';
import { useI18n } from 'vue-i18n';

export interface UsePageTitleOptions {
  running: Ref<boolean>;
  showAuthGate: Ref<boolean>;
}

export function usePageTitle({ running, showAuthGate }: UsePageTitleOptions): void {
  const { t } = useI18n();

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
    if (showAuthGate.value) return `${prefix}${t('app.authPageTitle')} - Kimi Code Web`;
    return `${prefix}Kimi Code Web`;
  });
  watchEffect(() => {
    if (typeof document !== 'undefined') document.title = pageTitle.value;
  });

  onUnmounted(() => {
    stopSpinner();
  });
}
