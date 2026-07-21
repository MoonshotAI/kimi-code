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
  isValidBinding,
  matchBinding,
  MENU_SYNCED_ACTIONS,
  SHORTCUT_ACTIONS,
  shortcutActionById,
  type ShortcutScope,
} from '../lib/keymap';
import { safeGetJson, safeSetJson, STORAGE_KEYS } from '../lib/storage';

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

watch(
  overrides,
  () => {
    safeSetJson(STORAGE_KEYS.shortcutOverrides, { ...overrides });
    pushMenuShortcuts();
  },
  { deep: true, immediate: true },
);

/** First action in `scope` whose effective binding matches the event. */
export function matchShortcutAction(e: KeyboardEvent, scope: ShortcutScope): string | null {
  for (const action of SHORTCUT_ACTIONS) {
    if (action.scope !== scope) continue;
    const binding = resolvedBinding(action.id);
    if (binding !== null && matchBinding(e, binding)) return action.id;
  }
  return null;
}
