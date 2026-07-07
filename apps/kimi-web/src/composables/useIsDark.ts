// apps/kimi-web/src/composables/useIsDark.ts
//
// Reactive "is the UI currently dark?" — resolves the three-state
// <html data-color-scheme> ('light' | 'dark' | 'system') against the OS
// preference, and tracks BOTH the attribute (user toggles the setting) and
// the media query (OS flips while in 'system'). Module-level singleton; the
// observers live for the app lifetime.

import { ref } from 'vue';
import type { Ref } from 'vue';

const isDark = ref(false);
let started = false;

function compute(): boolean {
  const scheme = document.documentElement.dataset.colorScheme;
  if (scheme === 'dark') return true;
  if (scheme === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function useIsDark(): Ref<boolean> {
  if (!started && typeof window !== 'undefined' && typeof document !== 'undefined') {
    started = true;
    isDark.value = compute();
    new MutationObserver(() => {
      isDark.value = compute();
    }).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-color-scheme'],
    });
    window
      .matchMedia('(prefers-color-scheme: dark)')
      .addEventListener('change', () => {
        isDark.value = compute();
      });
  }
  return isDark;
}
