
export interface RivePlaybackLike {
  play: () => void;
  pause: () => void;
}

export interface RivePlaybackSinks {
  isPageHidden?: () => boolean;
  onVisibilityChange?: (callback: () => void) => () => void;
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

export function bindRivePlayback(
  rive: RivePlaybackLike,
  element: Element,
  sinks: RivePlaybackSinks = {},
): () => void {
  const isPageHidden = sinks.isPageHidden ?? defaultSinks.isPageHidden;
  const onVisibilityChange = sinks.onVisibilityChange ?? defaultSinks.onVisibilityChange;
  const observeIntersection = sinks.observeIntersection ?? defaultSinks.observeIntersection;

  let pageVisible = !isPageHidden();
  let inView = true;
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
  apply();

  return () => {
    unwatchVisibility();
    unwatchIntersection();
  };
}
