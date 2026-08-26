// app-client — "工具调用汇总" advanced preference. Pure local UI state:
// only touches localStorage, never the session state or the API. The value
// is a module-level singleton so the whole app shares one instance.
//
// When ON (the default) an activity run ("Ran N commands" and friends) folds
// itself back into the summary row once every item settles — today's
// behavior. When OFF the tool-call summary is disabled: runs stay expanded
// and the summary row is not rendered at all (a still-running run shows its
// items inline, exactly as the expanded run does today).
//
// Independent from the message-fold switch (useTurnFolding) by design — two
// flags, two storage keys, no shared state, so one can change or be reverted
// without touching the other.
//
// localStorage is accessed through a tiny inline try/catch wrapper (the key
// below is owned solely by this module), so app-client does not import a
// consumer's storage module — same rationale as useComposerDraft.

import { ref } from 'vue';

const KEY_ACTIVITY_RUN_FOLDING = 'kimi-web.activity-run-folding';

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

/** The advanced toggle defaults ON: settled activity runs fold back into the
   summary row until the user opts out from Settings → Advanced. Only a
   stored '0' reads as off. */
function loadActivityRunFolding(): boolean {
  return storageGet(KEY_ACTIVITY_RUN_FOLDING) !== '0';
}

const activityRunFolding = ref<boolean>(loadActivityRunFolding());

function setActivityRunFolding(on: boolean): void {
  activityRunFolding.value = on;
  storageSet(KEY_ACTIVITY_RUN_FOLDING, on ? '1' : '0');
}

export function useActivityRunFolding() {
  return {
    /** True (default) = settled activity runs fold into the summary row;
        false = the tool-call summary is disabled and runs stay expanded. */
    activityRunFolding,
    setActivityRunFolding,
  };
}
