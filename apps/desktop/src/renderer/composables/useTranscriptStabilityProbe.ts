import { onBeforeUnmount, watch, type Ref } from 'vue';
import { useCanaryChannel } from '@moonshot-ai/app-client/composables';
import { createStabilityProbe, logWarn, type StabilityEvent, type StabilityProbe } from '@moonshot-ai/app-core/lib';

const LOG_WINDOW_MS = 60_000;
const LOG_LIMIT = 5;

export function useTranscriptStabilityProbe(scroller: Ref<HTMLElement | null>): void {
  const canary = useCanaryChannel();
  let probe: StabilityProbe | null = null;
  let windowStart = 0;
  let logged = 0;

  function log(event: StabilityEvent): void {
    const now = Date.now();
    if (now - windowStart > LOG_WINDOW_MS) {
      windowStart = now;
      logged = 0;
    }
    if (logged >= LOG_LIMIT) return;
    logged++;
    logWarn('transcript stability', { engine: 'legacy', ...event });
  }

  function sync(): void {
    probe?.stop();
    probe = null;
    const element = scroller.value;
    if (!element || !(import.meta.env.DEV || canary.isCanaryBuild.value)) return;
    probe = createStabilityProbe(element, { placeholderSelector: '.history-space', onEvent: log });
  }

  watch([scroller, canary.isCanaryBuild], sync, { immediate: true, flush: 'post' });
  onBeforeUnmount(() => {
    probe?.stop();
    probe = null;
  });
}
