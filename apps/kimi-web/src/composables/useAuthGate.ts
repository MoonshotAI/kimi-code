// apps/kimi-web/src/composables/useAuthGate.ts
// Auth readiness gates the main app. Once the first load finishes and auth is
// still missing, show a full-page login entry instead of an in-app banner.

import { computed, onUnmounted, ref, watch, type Ref } from 'vue';
import type { useKimiWebClient } from './useKimiWebClient';

type KimiWebClient = ReturnType<typeof useKimiWebClient>;

export interface UseAuthGateOptions {
  client: KimiWebClient;
  /** Template ref to the auth-page logo SVG; owned by the component so the
      template `ref=` binding links, passed here so the blink handler can drive it. */
  authLogoRef: Ref<SVGSVGElement | null>;
}

export function useAuthGate({ client, authLogoRef }: UseAuthGateOptions) {
  const authReady = computed(() => client.authReady.value);
  const showAuthGate = computed(() => client.initialized.value && !authReady.value);
  const LOGIN_PATH = '/login';
  const authReturnPath = ref<string | null>(null);
  let authLogoBlinkTimer: ReturnType<typeof setTimeout> | null = null;

  function currentPathWithSuffix(): string {
    if (typeof window === 'undefined') return '/';
    return `${window.location.pathname}${window.location.search}${window.location.hash}`;
  }

  function replaceBrowserPath(path: string): void {
    if (typeof window === 'undefined') return;
    window.history.replaceState(window.history.state, '', path);
  }

  watch(showAuthGate, (show) => {
    if (typeof window === 'undefined') return;
    if (show) {
      if (window.location.pathname !== LOGIN_PATH) {
        authReturnPath.value = currentPathWithSuffix();
        replaceBrowserPath(LOGIN_PATH);
      }
      return;
    }
    if (window.location.pathname === LOGIN_PATH) {
      replaceBrowserPath(authReturnPath.value ?? '/');
      authReturnPath.value = null;
    }
  }, { immediate: true });

  function blinkAuthLogo(): void {
    const el = authLogoRef.value;
    if (!el) return;
    el.classList.remove('blink-now');
    void el.getBoundingClientRect();
    el.classList.add('blink-now');
    if (authLogoBlinkTimer !== null) clearTimeout(authLogoBlinkTimer);
    authLogoBlinkTimer = setTimeout(() => {
      authLogoBlinkTimer = null;
      el.classList.remove('blink-now');
    }, 300);
  }

  onUnmounted(() => {
    if (authLogoBlinkTimer !== null) clearTimeout(authLogoBlinkTimer);
  });

  return { showAuthGate, blinkAuthLogo };
}
