// apps/kimi-web/src/composables/useIsMobile.ts
// Reactive "is the viewport narrow (phone-sized)?" flag.
//
// Drives the App.vue desktop/mobile branch. SSR/jsdom-safe: when
// window.matchMedia is unavailable (e.g. the test environment), it defaults to
// FALSE (desktop) so existing component tests keep mounting the desktop layout.

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

  // jsdom/SSR guard: no matchMedia → stay desktop (false).
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
