
import { ref } from 'vue';

const KEY_TURN_FOLDING = 'kimi-web.turn-folding';

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
  } catch {}
}

function loadTurnFolding(): boolean {
  return storageGet(KEY_TURN_FOLDING) === '1';
}

const turnFolding = ref<boolean>(loadTurnFolding());

function setTurnFolding(on: boolean): void {
  turnFolding.value = on;
  storageSet(KEY_TURN_FOLDING, on ? '1' : '0');
}

export function useTurnFolding() {
  return {
    turnFolding,
    setTurnFolding,
  };
}
