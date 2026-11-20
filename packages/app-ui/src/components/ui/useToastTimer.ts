import { onUnmounted } from 'vue';

export interface ToastTimer {
  pause: () => void;
  resume: () => void;
  dispose: () => void;
}

export function useToastTimer(options: { duration: () => number; onExpire: () => void }): ToastTimer {
  let handle: ReturnType<typeof setTimeout> | null = null;
  let deadline = 0;
  let remaining: number | null = null;

  function run(ms: number): void {
    handle = setTimeout(() => {
      handle = null;
      options.onExpire();
    }, ms);
    deadline = Date.now() + ms;
  }

  function pause(): void {
    if (handle === null) return;
    clearTimeout(handle);
    handle = null;
    remaining = Math.max(0, deadline - Date.now());
  }

  function resume(): void {
    if (handle !== null || remaining === null) return;
    const ms = remaining;
    remaining = null;
    run(ms);
  }

  function dispose(): void {
    if (handle !== null) clearTimeout(handle);
    handle = null;
    remaining = null;
  }

  const duration = options.duration();
  if (duration > 0) {
    const touch = typeof window !== 'undefined' && window.matchMedia?.('(hover: none)').matches === true;
    run(duration + (touch ? 5000 : 0));
  }
  onUnmounted(dispose);

  return { pause, resume, dispose };
}
