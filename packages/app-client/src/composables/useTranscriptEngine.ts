import { computed, ref, type ComputedRef, type Ref } from 'vue';
import { useCanaryChannel } from './useCanaryChannel';

export type TranscriptEngine = 'v2' | 'legacy';

const KEY_TRANSCRIPT_ENGINE = 'kimi-web.transcript-engine';

function storageGet(key: string): string | null {
  try {
    return globalThis.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    globalThis.localStorage.setItem(key, value);
  } catch {
    return;
  }
}

function loadTranscriptEngine(): TranscriptEngine | null {
  const stored = storageGet(KEY_TRANSCRIPT_ENGINE);
  return stored === 'v2' || stored === 'legacy' ? stored : null;
}

const storedEngine = ref<TranscriptEngine | null>(loadTranscriptEngine());
let transcriptEngine: ComputedRef<TranscriptEngine> | null = null;

function setTranscriptEngine(engine: TranscriptEngine): void {
  storedEngine.value = engine;
  storageSet(KEY_TRANSCRIPT_ENGINE, engine);
}

export function useTranscriptEngine(): {
  transcriptEngine: ComputedRef<TranscriptEngine>;
  storedTranscriptEngine: Readonly<Ref<TranscriptEngine | null>>;
  setTranscriptEngine: (engine: TranscriptEngine) => void;
} {
  if (transcriptEngine === null) {
    const canary = useCanaryChannel();
    transcriptEngine = computed(() => storedEngine.value ?? (canary.isCanaryBuild.value ? 'v2' : 'legacy'));
  }
  return { transcriptEngine, storedTranscriptEngine: storedEngine, setTranscriptEngine };
}
