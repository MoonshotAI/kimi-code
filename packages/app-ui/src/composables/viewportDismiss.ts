const subscribers = new Set<() => void>();
let installed = false;

function notify(): void {
  for (const subscriber of subscribers) subscriber();
}

function install(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('resize', notify);
}

function uninstall(): void {
  if (!installed) return;
  installed = false;
  window.removeEventListener('resize', notify);
}

export function subscribeViewportChange(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  install();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    subscribers.delete(subscriber);
    if (subscribers.size === 0) uninstall();
  };
}
