// apps/kimi-web/src/composables/useIsMobile.ts
// Reactive "is the viewport narrow (phone-sized)?" flag.
//
// Drives the App.vue desktop/mobile branch. When window.matchMedia is
// unavailable, it defaults to FALSE (desktop).

import { onUnmounted, ref, type Ref } from 'vue';

/** Phones / very narrow viewports use the single-column mobile shell. */
export const MOBILE_MAX_WIDTH = 640;
const MOBILE_QUERY = `(max-width: ${MOBILE_MAX_WIDTH}px)`;

/**
 * Returns a reactive ref that is `true` on narrow (≤640px) viewports and
 * `false` otherwise. Guarded for environments without matchMedia.
 */
export function useIsMobile(): Ref<boolean> {
  const isMobile = ref(false);

  // SSR / no-matchMedia guard: stay desktop (false).
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return isMobile;
  }

  const mql = window.matchMedia(MOBILE_QUERY);
  isMobile.value = mql.matches;

  const onChange = (e: MediaQueryListEvent | MediaQueryList): void => {
    isMobile.value = e.matches;
  };

  // addEventListener is the modern API; addListener is the deprecated fallback
  // for older Safari. Guard both so we never throw.
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', onChange);
    onUnmounted(() => mql.removeEventListener('change', onChange));
  } else if (typeof mql.addListener === 'function') {
    // eslint-disable-next-line deprecation/deprecation
    mql.addListener(onChange);
    // eslint-disable-next-line deprecation/deprecation
    onUnmounted(() => mql.removeListener(onChange));
  }

  return isMobile;
}
