// Gate a Rive instance's render loop on page visibility and viewport
// intersection. A playing Rive state machine schedules a requestAnimationFrame
// every display frame (120fps on a 120Hz screen) for as long as it runs, which
// keeps the CPU/GPU out of idle whenever the page is on screen; pausing the
// instance lets the runtime drop its frame loop entirely. Framework-free and
// structural (same pattern as riveInputs) so it's unit-testable without the
// wasm runtime.

export interface RivePlaybackLike {
  /** Resume whatever was playing (Rive's no-arg play). */
  play: () => void;
  /** Pause all playing animations/state machines (stops the frame loop). */
  pause: () => void;
}

/** Environment sinks, injectable for tests. Any sink left undefined falls back
    to the browser default (document / IntersectionObserver). */
export interface RivePlaybackSinks {
  /** True while the page is hidden (document.hidden). */
  isPageHidden?: () => boolean;
  /** Subscribe to page-visibility flips; returns an unsubscribe. */
  onVisibilityChange?: (callback: () => void) => () => void;
  /** Watch an element's viewport intersection; returns an unsubscribe. When
      the platform has no IntersectionObserver the default is a no-op and the
      element counts as always in view. */
  observeIntersection?: (
    element: Element,
    callback: (inView: boolean) => void,
  ) => () => void;
}

const defaultSinks: Required<RivePlaybackSinks> = {
  isPageHidden: () => typeof document !== 'undefined' && document.hidden,
  onVisibilityChange: (callback) => {
    if (typeof document === 'undefined') return () => {};
    document.addEventListener('visibilitychange', callback);
    return () => document.removeEventListener('visibilitychange', callback);
  },
  observeIntersection: (element, callback) => {
    if (typeof IntersectionObserver !== 'function') return () => {};
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) callback(entry.isIntersecting);
    });
    observer.observe(element);
    return () => observer.disconnect();
  },
};

/**
 * Pause `rive` while the page is hidden or `element` is scrolled out of the
 * viewport; resume once both allow playback again. Returns the teardown.
 *
 * Bind only once the instance is loaded and playing: a resume is issued solely
 * as the counterpart of a pause made here, so this helper never starts an
 * instance that was not already running.
 */
export function bindRivePlayback(
  rive: RivePlaybackLike,
  element: Element,
  sinks: RivePlaybackSinks = {},
): () => void {
  const isPageHidden = sinks.isPageHidden ?? defaultSinks.isPageHidden;
  const onVisibilityChange = sinks.onVisibilityChange ?? defaultSinks.onVisibilityChange;
  const observeIntersection = sinks.observeIntersection ?? defaultSinks.observeIntersection;

  let pageVisible = !isPageHidden();
  let inView = true; // until the observer's first callback says otherwise
  let paused = false;

  function apply(): void {
    const shouldPause = !pageVisible || !inView;
    if (shouldPause === paused) return;
    paused = shouldPause;
    if (paused) rive.pause();
    else rive.play();
  }

  const unwatchVisibility = onVisibilityChange(() => {
    pageVisible = !isPageHidden();
    apply();
  });
  const unwatchIntersection = observeIntersection(element, (visible) => {
    inView = visible;
    apply();
  });
  apply(); // a hidden page pauses immediately; no-op otherwise

  return () => {
    unwatchVisibility();
    unwatchIntersection();
  };
}
