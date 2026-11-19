export function createBrowserFocusRequest(options: { allowInactiveDocument?: boolean } = {}) {
  let cancelPending: (() => void) | null = null;

  async function run(prepare: () => Promise<unknown>, focus: () => void, available: () => boolean): Promise<void> {
    cancelPending?.();
    if (!available()) return;
    let cancelled = false;
    const cleanup = (): void => {
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('keydown', cancel, true);
      document.removeEventListener('visibilitychange', cancel);
      window.removeEventListener('blur', cancel);
      if (cancelPending === cancel) cancelPending = null;
    };
    const cancel = (): void => { cancelled = true; cleanup(); };
    cancelPending = cancel;
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('keydown', cancel, true);
    document.addEventListener('visibilitychange', cancel);
    window.addEventListener('blur', cancel);
    try {
      await prepare();
      if (!cancelled && available() && (options.allowInactiveDocument === true || document.hasFocus())) focus();
    } finally {
      cleanup();
    }
  }

  return { run, cancel: () => cancelPending?.() };
}
