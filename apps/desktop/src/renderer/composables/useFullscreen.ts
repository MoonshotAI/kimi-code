
import { ref, type Ref } from 'vue';

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
      .catch(() => {});
    bridge.onFullscreenChanged((flag) => {
      isFullscreen.value = flag === true;
    });
  }
  return isFullscreen;
}

let tracker: Ref<boolean> | null = null;

export function useFullscreen(): Ref<boolean> {
  if (tracker === null) {
    tracker = createFullscreenTracker(
      (window as { kimiDesktop?: FullscreenBridge }).kimiDesktop,
    );
  }
  return tracker;
}
