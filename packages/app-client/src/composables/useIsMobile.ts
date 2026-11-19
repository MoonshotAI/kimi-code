
import { onUnmounted, ref, type Ref } from 'vue';

export const MOBILE_MAX_WIDTH = 640;
const MOBILE_QUERY = `(max-width: ${MOBILE_MAX_WIDTH}px)`;

export function useIsMobile(): Ref<boolean> {
  const isMobile = ref(false);

  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return isMobile;
  }

  const mql = window.matchMedia(MOBILE_QUERY);
  isMobile.value = mql.matches;

  const onChange = (e: MediaQueryListEvent | MediaQueryList): void => {
    isMobile.value = e.matches;
  };

  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', onChange);
    onUnmounted(() => mql.removeEventListener('change', onChange));
  } else if (typeof mql.addListener === 'function') {
    mql.addListener(onChange);
    onUnmounted(() => mql.removeListener(onChange));
  }

  return isMobile;
}
