// apps/desktop/src/renderer/composables/useShortcuts.ts
// Desktop-only customizable keyboard shortcuts: the reactive override map on
// top of lib/keymap.ts's pure registry. Overrides persist to localStorage
// (`kimi-web.shortcut-overrides`) and the open-settings binding is pushed to
// the main process so the native app menu's accelerator follows the user's
// choice (main/menu.ts). Web keeps hardcoded keys (docs/native-todos.md).
//
// The override map is module-level state (like nativeOpenIn.ts's default
// target): every consumer — App.vue's dispatcher, Composer, ConversationPane,
// Sidebar keycaps, the settings panel — sees a rebind in the same tick.

import { reactive, watch } from 'vue';
import {
  formatBindingKeys,
  isHardcodedBinding,
  isHardcodedFindBinding,
  isValidBinding,
  matchBinding,
  MENU_SYNCED_ACTIONS,
  SHORTCUT_ACTIONS,
  shortcutActionById,
  type ShortcutScope,
} from '../lib/keymap';
import { safeGetJson, safeSetJson, STORAGE_KEYS } from '../lib/storage';
import type { ShortcutActionId } from '../../shared/action-ids';

/** action id → canonical binding (null = unassigned; absent = default). */
export type ShortcutOverrides = Record<string, string | null>;

function loadOverrides(): ShortcutOverrides {
  const raw = safeGetJson<unknown>(STORAGE_KEYS.shortcutOverrides);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: ShortcutOverrides = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const action = shortcutActionById(id);
    // Drop entries for unknown actions and malformed bindings (e.g. written by
    // a newer build) instead of carrying them forever.
    if (action === undefined) continue;
    if (value === null) {
      out[id] = null;
    } else if (typeof value === 'string' && isValidBinding(value, action.scope)) {
      // Legacy overrides a later reservation made dead (e.g. mod+f bound
      // before the find bar reserved it) migrate to explicitly UNASSIGNED —
      // dropping them would silently restore the default binding, which the
      // user may have assigned to another action in the meantime.
      if (isHardcodedBinding(value) || isHardcodedFindBinding(value)) {
        out[id] = null;
        continue;
      }
      out[id] = value;
    }
  }
  return out;
}

const overrides = reactive<ShortcutOverrides>(loadOverrides());

/** Effective binding for an action: the override when set (null stays
 *  unassigned), otherwise the registry default. */
export function resolvedBinding(id: string): string | null {
  const override = overrides[id];
  if (override !== undefined) return override;
  return shortcutActionById(id)?.defaultBinding ?? null;
}

/** Keycap labels of the effective binding, for <Kbd :keys="…"> hints. */
export function resolvedBindingKeys(id: string): string[] {
  const binding = resolvedBinding(id);
  return binding === null ? [] : formatBindingKeys(binding);
}

/** Assign (or clear, with null) an action's binding. Callers validate first
 *  (the settings panel shows the error); invalid bindings are refused here
 *  too so a bad write can never brick the map. */
export function setShortcutBinding(id: string, binding: string | null): boolean {
  const action = shortcutActionById(id);
  if (action === undefined) return false;
  if (binding !== null && !isValidBinding(binding, action.scope)) return false;
  overrides[id] = binding;
  return true;
}

/** Back to the registry default. */
export function resetShortcutBinding(id: string): void {
  delete overrides[id];
}

export function resetAllShortcutBindings(): void {
  for (const id of Object.keys(overrides)) {
    delete overrides[id];
  }
}

export function isShortcutCustomized(id: string): boolean {
  return id in overrides;
}

export function useShortcutOverrides(): ShortcutOverrides {
  return overrides;
}

// ---------------------------------------------------------------------------
// Main-process menu sync: the native menu items mirroring renderer actions
// (Settings / New Chat / Open Folder — keymap.ts MENU_SYNCED_ACTIONS) show
// the user's current bindings as their accelerators (a menu accelerator wins
// over the renderer keydown, so the two can never disagree). Pushed on every
// change and once at startup (immediate watch); no bridge → no-op (plain web,
// or an old preload that predates the channel).
// ---------------------------------------------------------------------------

interface MenuShortcutBridge {
  setMenuShortcuts?: (bindings: Record<string, string | null>) => void;
}

function pushMenuShortcuts(): void {
  // No window (node test env, SSR): the no-bridge path must be a real no-op.
  if (typeof window === 'undefined') return;
  const bridge = (window as { kimiDesktop?: MenuShortcutBridge }).kimiDesktop;
  if (typeof bridge?.setMenuShortcuts !== 'function') return;
  const bindings: Record<string, string | null> = {};
  for (const id of MENU_SYNCED_ACTIONS) {
    bindings[id] = resolvedBinding(id);
  }
  bridge.setMenuShortcuts(bindings);
}

// ---------------------------------------------------------------------------
// OS-level global shortcut sync: summonApp is registered with
// globalShortcut by the main process (main/shortcuts.ts) so it fires even
// when the window is hidden or unfocused. Pushed on every change and once at
// startup (same immediate watch); no bridge → no-op.
// ---------------------------------------------------------------------------

const GLOBAL_SHORTCUT_ACTIONS = ['summonApp'] as const;

interface GlobalShortcutBridge {
  setGlobalShortcut?: (action: string, binding: string | null) => Promise<boolean>;
}

/** OS-global bindings the OS refused to register (already taken by the system
 *  or another app), keyed by action id. The settings panel shows these inline
 *  — a persisted binding that can never fire must not look successful. Covers
 *  every push path (startup replay, reset-to-default, rebind rollback); the
 *  recording flow has its own await-and-roll-back path on top. Cleared on the
 *  next successful registration. */
export const osGlobalFailures = reactive<Record<string, true>>({});

async function pushGlobalShortcuts(): Promise<void> {
  if (typeof window === 'undefined') return;
  const bridge = (window as { kimiDesktop?: GlobalShortcutBridge }).kimiDesktop;
  if (typeof bridge?.setGlobalShortcut !== 'function') return;
  for (const id of GLOBAL_SHORTCUT_ACTIONS) {
    const ok = await bridge.setGlobalShortcut(id, resolvedBinding(id));
    if (ok) {
      delete osGlobalFailures[id];
    } else {
      osGlobalFailures[id] = true;
    }
  }
}

watch(
  overrides,
  () => {
    safeSetJson(STORAGE_KEYS.shortcutOverrides, { ...overrides });
    pushMenuShortcuts();
    void pushGlobalShortcuts();
  },
  { deep: true, immediate: true },
);

/** First action in `scope` whose effective binding matches the event. */
export function matchShortcutAction(e: KeyboardEvent, scope: ShortcutScope): ShortcutActionId | null {
  for (const action of SHORTCUT_ACTIONS) {
    if (action.scope !== scope) continue;
    const binding = resolvedBinding(action.id);
    if (binding !== null && matchBinding(e, binding)) return action.id;
  }
  return null;
}
