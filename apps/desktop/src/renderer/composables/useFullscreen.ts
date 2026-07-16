// apps/desktop/src/renderer/composables/useFullscreen.ts
// Desktop-only reactive "is the native window fullscreen?" flag.
//
// The main process pushes every enter/leave-full-screen transition over the
// `kimi:fullscreen-changed` bridge event; the initial state is queried once
// (invoke) so a renderer (re)load while already fullscreen starts out right.
// With no bridge (plain web, tests) the flag stays false and every fullscreen
// rule in App.vue stays inert — the no-bridge fallback, per native-todos.md.
//
// Sole consumer today: the macOS-desktop resident sidebar toggle. In
// fullscreen the traffic lights hide, so the button drops their left slot and
// hugs the window edge (see App.vue `.app.macos-desktop.fullscreen`).

import { ref, type Ref } from 'vue';

// Subset of the preload `kimiDesktop` bridge this tracker needs.
interface FullscreenBridge {
  isFullscreen: () => Promise<boolean>;
  onFullscreenChanged: (cb: (fullscreen: boolean) => void) => () => void;
}

export function createFullscreenTracker(bridge: FullscreenBridge | undefined): Ref<boolean> {
  const isFullscreen = ref(false);
  if (bridge !== undefined) {
    void bridge
      .isFullscreen()
      .then((flag) => {
        isFullscreen.value = flag === true;
      })
      .catch(() => {
        // Bridge failure: keep the non-fullscreen layout.
      });
    bridge.onFullscreenChanged((flag) => {
      isFullscreen.value = flag === true;
    });
  }
  return isFullscreen;
}

// Singleton: App.vue calls this once, and the underlying bridge subscription
// lives for the app's lifetime.
let tracker: Ref<boolean> | null = null;

export function useFullscreen(): Ref<boolean> {
  if (tracker === null) {
    tracker = createFullscreenTracker(
      (window as { kimiDesktop?: FullscreenBridge }).kimiDesktop,
    );
  }
  return tracker;
}
