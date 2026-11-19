import { onScopeDispose, ref, watch } from 'vue';

export function useEscInterrupt(options: {
  sessionId: () => string | undefined;
  working: () => boolean | undefined;
  interrupt: () => void;
}) {
  const armed = ref(false);
  let deadline = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function reset(): void {
    clearTimeout(timer);
    timer = undefined;
    deadline = 0;
    armed.value = false;
  }

  function press(): void {
    if (!options.working()) return;
    if (armed.value && Date.now() < deadline) {
      reset();
      options.interrupt();
      return;
    }
    reset();
    armed.value = true;
    deadline = Date.now() + 2000;
    timer = setTimeout(reset, 2000);
  }

  watch([options.sessionId, options.working], reset, { flush: 'sync' });
  onScopeDispose(reset);

  return { armed, press, reset };
}
