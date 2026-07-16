// apps/kimi-web/src/composables/hostColorScheme.ts
// Host-pushed color scheme for embedded hosts (the VS Code extension view).
// VS Code theming does NOT propagate `prefers-color-scheme` into the
// cross-origin iframe the extension embeds the web UI in, so the extension
// pushes its active theme kind as a postMessage; 'system' then resolves
// against the host theme (see useAppearance) instead of the media query.
// Module-level singleton; the listener lives for the app lifetime.

import { ref, type Ref } from 'vue';

export type HostColorScheme = 'light' | 'dark';

const MESSAGE_TYPE = 'kimi-host-color-scheme';

const scheme = ref<HostColorScheme | null>(null);
let started = false;

/** The host's current color scheme, or null when not embedded / not known yet. */
export function useHostColorScheme(): Ref<HostColorScheme | null> {
  if (!started && typeof window !== 'undefined') {
    started = true;
    window.addEventListener('message', (event) => {
      const data = event.data as { type?: unknown; scheme?: unknown } | null;
      if (
        data !== null &&
        typeof data === 'object' &&
        data.type === MESSAGE_TYPE &&
        (data.scheme === 'dark' || data.scheme === 'light')
      ) {
        scheme.value = data.scheme;
      }
    });
  }
  return scheme;
}
