// app-client — "消息自动折叠" advanced preference. Pure local UI state: only
// touches localStorage, never the session state or the API. The value is a
// module-level singleton so the whole app shares one instance.
//
// When OFF (the default) the turn-level fold is disabled: a settled turn's
// working blocks render inline exactly as they did while the turn streamed —
// no "Worked Ns" row at all (ChatPane takes the inspector's flatten path).
// When ON the fold behaves as it always has: once the stream moves past a
// turn, everything before its final text block folds into the "Worked Ns"
// row (manual toggles still work per row).
//
// Independent from the tool-call-summary switch (useActivityRunFolding) by
// design — two flags, two storage keys, no shared state, so one can change
// or be reverted without touching the other.
//
// localStorage is accessed through a tiny inline try/catch wrapper (the key
// below is owned solely by this module), so app-client does not import a
// consumer's storage module — same rationale as useComposerDraft.

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
  } catch {
    // storage unavailable (private mode, quota, etc.) — ignore
  }
}

/** The advanced toggle defaults OFF: settled turns render fully expanded
   until the user opts into folding from Settings → Advanced. Only a stored
   '1' reads as on. */
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
    /** True = settled turns fold into the "Worked Ns" row; false (default) =
        the turn-level fold is disabled and turns stay fully expanded. */
    turnFolding,
    setTurnFolding,
  };
}
