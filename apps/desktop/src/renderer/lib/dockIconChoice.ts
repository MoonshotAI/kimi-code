// Desktop-only Dock icon preference ('light' | 'dark'; docs/native-todos.md).
// The choice persists in localStorage and is pushed to the main process over
// the preload bridge; the main process swaps the Dock tile
// (src/main/dock-icon.ts). Web has no Dock and no bridge — like lib/keymap.ts,
// this file is NOT synced to apps/web.
import { ref, watch, type Ref } from 'vue';
import { STORAGE_KEYS, safeGetString, safeSetString } from '@moonshot-ai/app-core/lib';

export type DockIconChoice = 'light' | 'dark';

interface DockIconBridge {
  setDockIconChoice?: (choice: DockIconChoice) => void;
}

function bridge(): DockIconBridge | undefined {
  return (window as { kimiDesktop?: DockIconBridge }).kimiDesktop;
}

/** True when the preload bridge can receive the choice (desktop app). */
export function canSetDockIconChoice(): boolean {
  return typeof bridge()?.setDockIconChoice === 'function';
}

/** Persisted preference; anything unexpected (including the retired 'auto')
    falls back to 'light' — the tile shipped in the packaged .icns. */
export function loadDockIconChoice(): DockIconChoice {
  const value = safeGetString(STORAGE_KEYS.dockIconChoice);
  return value === 'dark' ? 'dark' : 'light';
}

// Module-level reactive mirror of the persisted choice (same pattern as
// nativeOpenIn's defaultTarget), so the settings row reacts in the same tick.
const choice: Ref<DockIconChoice> = ref(loadDockIconChoice());

function push(value: DockIconChoice): void {
  try {
    bridge()?.setDockIconChoice?.(value);
  } catch {
    // No bridge / old bridge — the settings row is hidden then anyway.
  }
}

watch(choice, (value) => {
  safeSetString(STORAGE_KEYS.dockIconChoice, value);
  push(value);
});

// Startup seed: the main process applies the ui-state.json mirror at launch,
// so the tile is right even before this push arrives (no persist here — only
// the push; the mirror is written main-side on every setDockIconChoice).
push(choice.value);

/** Shared reactive Dock-icon preference (default 'light'). */
export function useDockIconChoice(): Ref<DockIconChoice> {
  return choice;
}
