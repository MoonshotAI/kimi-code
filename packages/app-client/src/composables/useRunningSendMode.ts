import { ref } from 'vue';

export type RunningSendMode = 'steer' | 'queue';

const KEY_RUNNING_SEND_MODE = 'kimi-web.running-send-mode';
const KEY_RUNNING_SEND_TIP_SEEN = 'kimi-web.running-send-steer-tip-seen';

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

function parseRunningSendMode(raw: string | null): RunningSendMode | null {
  if (raw === 'steer' || raw === 'queue') return raw;
  return null;
}

function loadRunningSendMode(): RunningSendMode {
  return parseRunningSendMode(storageGet(KEY_RUNNING_SEND_MODE)) ?? 'steer';
}

function loadRunningSendTipSeen(): boolean {
  return (
    storageGet(KEY_RUNNING_SEND_TIP_SEEN) === '1' ||
    parseRunningSendMode(storageGet(KEY_RUNNING_SEND_MODE)) !== null
  );
}

const runningSendMode = ref<RunningSendMode>(loadRunningSendMode());
const runningSendTipVisible = ref<boolean>(false);
let runningSendTipSeen = loadRunningSendTipSeen();

function setRunningSendMode(mode: RunningSendMode): void {
  runningSendMode.value = mode;
  runningSendTipSeen = true;
  runningSendTipVisible.value = false;
  storageSet(KEY_RUNNING_SEND_MODE, mode);
  storageSet(KEY_RUNNING_SEND_TIP_SEEN, '1');
}

function noteDefaultRunningSteerTriggered(): void {
  if (runningSendTipSeen) return;
  runningSendTipSeen = true;
  storageSet(KEY_RUNNING_SEND_TIP_SEEN, '1');
  runningSendTipVisible.value = true;
}

function dismissRunningSendTip(): void {
  runningSendTipSeen = true;
  runningSendTipVisible.value = false;
  storageSet(KEY_RUNNING_SEND_TIP_SEEN, '1');
}

export function useRunningSendMode() {
  return {
    runningSendMode,
    runningSendTipVisible,
    setRunningSendMode,
    noteDefaultRunningSteerTriggered,
    dismissRunningSendTip,
  };
}
