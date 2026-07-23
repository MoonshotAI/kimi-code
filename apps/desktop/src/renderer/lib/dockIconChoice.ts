// Desktop-only Dock icon preference ('light' | 'dark' | 'auto';
// docs/native-todos.md). The choice persists in localStorage and is pushed to
// the main process over the preload bridge; the main process swaps the Dock
// tile (src/main/dock-icon.ts). Web has no Dock and no bridge — like
// lib/keymap.ts, this file is NOT synced to apps/web.
import { ref, watch, type Ref } from 'vue';
import { STORAGE_KEYS, safeGetString, safeSetString } from './storage';

export type DockIconChoice = 'light' | 'dark' | 'auto';

interface DockIconBridge {
  setDockIconChoice?: (choice: DockIconChoice) => void;
  getOsAppearance?: () => Promise<'dark' | 'light'>;
  onOsAppearanceChanged?: (cb: (appearance: 'dark' | 'light') => void) => () => void;
}

function bridge(): DockIconBridge | undefined {
  return (window as { kimiDesktop?: DockIconBridge }).kimiDesktop;
}

/** True when the preload bridge can receive the choice (desktop app). */
export function canSetDockIconChoice(): boolean {
  return typeof bridge()?.setDockIconChoice === 'function';
}

/** True when the bridge reports the real OS appearance (newer bridges). */
export function canQueryOsAppearance(): boolean {
  return typeof bridge()?.getOsAppearance === 'function' && typeof bridge()?.onOsAppearanceChanged === 'function';
}

/** Real OS appearance from the main process; null when unavailable. */
export async function getOsAppearance(): Promise<'dark' | 'light' | null> {
  if (!canQueryOsAppearance()) return null;
  try {
    const value = await bridge()!.getOsAppearance!();
    return value === 'dark' ? 'dark' : 'light';
  } catch {
    return null;
  }
}

/** Subscribe to OS appearance pushes; returns the unsubscribe (no-op without bridge). */
export function onOsAppearanceChanged(cb: (appearance: 'dark' | 'light') => void): () => void {
  if (!canQueryOsAppearance()) return () => {};
  try {
    return bridge()!.onOsAppearanceChanged!(cb);
  } catch {
    return () => {};
  }
}

/** Persisted preference; anything unexpected falls back to 'auto'. */
export function loadDockIconChoice(): DockIconChoice {
  const value = safeGetString(STORAGE_KEYS.dockIconChoice);
  return value === 'light' || value === 'dark' ? value : 'auto';
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

// Startup seed: the main process defaults to 'auto' until the stored choice
// arrives (no persist here — only the push).
push(choice.value);

/** Shared reactive Dock-icon preference (default 'auto'). */
export function useDockIconChoice(): Ref<DockIconChoice> {
  return choice;
}
