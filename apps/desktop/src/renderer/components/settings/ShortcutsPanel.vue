<!-- apps/desktop/src/renderer/components/settings/ShortcutsPanel.vue -->
<!-- Desktop-only "Hotkeys" settings tab: searchable list of every
     bindable action (lib/keymap.ts registry) with record-to-rebind editing.
     Bindings persist via useShortcuts; web has no such tab (docs/native-todos.md).

     Editing model: the pencil starts a capture-phase recorder for the next
     key combo — it preventDefaults + stops propagation so neither the App
     dispatcher nor the dialog's own Escape handler sees the key. Escape
     cancels; pure modifier presses keep waiting. Illegal combos (bare
     printable keys) and same-scope conflicts are rejected inline. -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, Icon, IconButton, Kbd } from '@moonshot-ai/web-ui';
import {
  bindingFromEvent,
  findConflict,
  formatBindingKeys,
  isAcceleratorExpressible,
  isAppleShortcutPlatform,
  isHardcodedBinding,
  isHardcodedFindBinding,
  isReservedBinding,
  isValidBinding,
  isValidMenuBinding,
  MENU_SYNCED_ACTIONS,
  OS_GLOBAL_ACTIONS,
  SHORTCUT_ACTIONS,
  shortcutActionById,
  type ShortcutAction,
} from '../../lib/keymap';
import {
  isShortcutCustomized,
  osGlobalFailures,
  resetAllShortcutBindings,
  resetShortcutBinding,
  resolvedBinding,
  setShortcutBinding,
  useShortcutOverrides,
} from '../../composables/useShortcuts';

const { t } = useI18n();
const overrides = useShortcutOverrides();

const query = ref('');
const recordingId = ref<string | null>(null);
const recordError = ref<string | null>(null);
// Error pinned to a row OUTSIDE recording (e.g. a refused reset).
const rowError = ref<{ id: string; message: string } | null>(null);
// Modifier caps of the combo being held down right now (live preview inside
// the recording chip); empty while no modifier is held.
const liveKeys = ref<string[]>([]);

/** Keycaps for the currently held modifiers, canonical display order. */
function modifierKeysOf(e: KeyboardEvent): string[] {
  const isApple = isAppleShortcutPlatform();
  const keys: string[] = [];
  if (isApple && e.ctrlKey) keys.push('⌃');
  if (e.altKey) keys.push(isApple ? '⌥' : 'Alt');
  if (e.shiftKey) keys.push(isApple ? '⇧' : 'Shift');
  if (isApple ? e.metaKey : e.ctrlKey) keys.push(isApple ? '⌘' : 'Ctrl');
  return keys;
}

function matchesQuery(action: ShortcutAction, q: string): boolean {
  if (q === '') return true;
  if (t(action.labelKey).toLowerCase().includes(q)) return true;
  if (t(action.descKey).toLowerCase().includes(q)) return true;
  const binding = resolvedBinding(action.id);
  return binding !== null && formatBindingKeys(binding).join(' ').toLowerCase().includes(q);
}

// One flat list (registry order), narrowed by the search box.
const filteredActions = computed(() => {
  const q = query.value.trim().toLowerCase();
  return SHORTCUT_ACTIONS.filter((action) => matchesQuery(action, q));
});

function bindingKeys(id: string): string[] {
  const binding = resolvedBinding(id);
  return binding === null ? [] : formatBindingKeys(binding);
}

function startRecording(action: ShortcutAction): void {
  recordingId.value = action.id;
  recordError.value = null;
  rowError.value = null;
  liveKeys.value = [];
  setMenuSuspended(true);
  setGlobalShortcutSuspended(true);
}

function stopRecording(): void {
  recordingId.value = null;
  recordError.value = null;
  liveKeys.value = [];
  setMenuSuspended(false);
  setGlobalShortcutSuspended(false);
}

// While recording, the native menu's accelerators must not fire either —
// they intercept BEFORE the renderer (recording ⌘R would reload the app
// instead of showing the reserved hint). The main process disables the
// whole menu bar (editMenu excepted) until the recording ends. The summon-app
// global shortcut has the same problem at the OS level: the current combo
// would be consumed before reaching the recorder, so it unregisters too.
interface MenuSuspendBridge {
  setMenuSuspended?: (suspended: boolean) => void;
  setGlobalShortcutSuspended?: (suspended: boolean) => Promise<boolean>;
}

function setMenuSuspended(suspended: boolean): void {
  (window as { kimiDesktop?: MenuSuspendBridge }).kimiDesktop?.setMenuSuspended?.(suspended);
}

function setGlobalShortcutSuspended(suspended: boolean): void {
  void (window as { kimiDesktop?: MenuSuspendBridge }).kimiDesktop?.setGlobalShortcutSuspended?.(suspended);
}

/** Finish an OS-global recording: resume registrations with the new chord
 *  (the override → main-process push is deferred while suspended; nextTick
 *  flushes it ahead of the resume) and roll back with an inline error when
 *  the OS refuses it (already taken by the system or another app) — without
 *  the rollback the row would show a binding that can never fire. */
async function finishOsGlobalRecording(
  id: string,
  previous: { customized: boolean; binding: string | null | undefined },
): Promise<void> {
  await nextTick();
  const bridge = (window as { kimiDesktop?: MenuSuspendBridge }).kimiDesktop;
  const ok = (await bridge?.setGlobalShortcutSuspended?.(false)) ?? true;
  recordingId.value = null;
  recordError.value = null;
  liveKeys.value = [];
  setMenuSuspended(false);
  if (ok) return;
  if (previous.customized) {
    setShortcutBinding(id, previous.binding ?? null);
  } else {
    resetShortcutBinding(id);
  }
  rowError.value = { id, message: t('shortcuts.globalTaken') };
}

function onRecordKeydown(e: KeyboardEvent): void {
  const id = recordingId.value;
  if (id === null) return;
  // The recorded combo must never reach the app: not the App dispatcher, not
  // the dialog's Escape-to-close, not the focused input below.
  e.preventDefault();
  e.stopPropagation();
  // Only a BARE Escape cancels the recording — modifier+Escape chords are
  // legitimate bindings (e.g. for the interrupt action) and must record.
  if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
    stopRecording();
    return;
  }
  const action = shortcutActionById(id);
  if (action === undefined) {
    stopRecording();
    return;
  }
  // AltGr is text input (Windows/Linux layouts report it as ctrl+alt):
  // runtime matching deliberately never fires on it, so a recorded one
  // would be dead on arrival.
  if (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph')) {
    recordError.value = t('shortcuts.invalid');
    liveKeys.value = [];
    return;
  }
  const binding = bindingFromEvent(e);
  if (binding === null) {
    // Pure modifier press — echo the held combo in the chip while waiting.
    liveKeys.value = modifierKeysOf(e);
    return;
  }
  // Menu-backed actions (Settings / New Chat / Open Folder) install a native
  // menu accelerator, which intercepts the combo app-wide — they must carry a
  // modifier, and findConflict already checks them across every scope.
  const menuBacked = MENU_SYNCED_ACTIONS.includes(id);
  if (!isValidBinding(binding, action.scope) || (menuBacked && !isValidMenuBinding(binding))) {
    recordError.value = t('shortcuts.invalid');
    liveKeys.value = [];
    return;
  }
  // OS-global actions (summonApp) are registered with globalShortcut and have
  // NO renderer fallback: they need a real modifier (a bare key would be
  // stolen from every app system-wide), must not be AltGr-shaped (would fire
  // while typing AltGr characters), and must be expressible as an Electron
  // accelerator (e.g. ⌘' can never fire) — reject all of it up front.
  if (OS_GLOBAL_ACTIONS.includes(id) && (!isValidMenuBinding(binding) || !isAcceleratorExpressible(binding))) {
    recordError.value = t('shortcuts.notGlobal');
    liveKeys.value = [];
    return;
  }
  // Native menu role accelerators (reload, close window, edit menu, …) win
  // over the renderer keydown, so a colliding custom binding would be dead —
  // or dangerous ('mod+r' reloads the app).
  if (isReservedBinding(binding)) {
    recordError.value = t('shortcuts.reserved');
    liveKeys.value = [];
    return;
  }
  // Hardcoded app chords (steer Ctrl/Cmd+S) are consumed by the composer
  // before any customizable key — same dead-binding outcome.
  if (isHardcodedBinding(binding)) {
    recordError.value = t('shortcuts.reservedSteer');
    liveKeys.value = [];
    return;
  }
  // The transcript find bar owns Cmd/Ctrl+F the same way (ConversationPane's
  // document handler consumes it before the app dispatcher).
  if (isHardcodedFindBinding(binding)) {
    recordError.value = t('shortcuts.reservedFind');
    liveKeys.value = [];
    return;
  }
  const conflictId = findConflict(overrides, action.scope, binding, id);
  if (conflictId !== null) {
    const other = shortcutActionById(conflictId);
    recordError.value = t('shortcuts.conflict', { action: other === undefined ? conflictId : t(other.labelKey) });
    liveKeys.value = [];
    return;
  }
  const previous = { customized: isShortcutCustomized(id), binding: overrides[id] };
  setShortcutBinding(id, binding);
  // OS-global actions: the binding only goes live when the suspended
  // registration resumes — finalize asynchronously so a refused chord rolls
  // back with an error instead of sitting dead in the row.
  if (OS_GLOBAL_ACTIONS.includes(id)) {
    void finishOsGlobalRecording(id, previous);
    return;
  }
  stopRecording();
}

onMounted(() => document.addEventListener('keydown', onRecordKeydown, true));
onUnmounted(() => document.removeEventListener('keydown', onRecordKeydown, true));

// Resetting restores the default binding — which must not collide with an
// override placed on ANOTHER action meanwhile (unassign A, bind B to A's
// default, then reset A would leave both on the same combo, with A's earlier
// registry position silently shadowing B). The restored extraBindings
// (expanded-editor aliases) are checked the same way. Refuse and say so
// instead.
function onReset(action: ShortcutAction): void {
  if (action.defaultBinding !== null) {
    const remaining = { ...overrides };
    delete remaining[action.id];
    const restored = [action.defaultBinding, ...(action.extraBindings ?? [])];
    for (const candidate of restored) {
      const conflictId = findConflict(remaining, action.scope, candidate, action.id);
      if (conflictId !== null) {
        const other = shortcutActionById(conflictId);
        rowError.value = {
          id: action.id,
          message: t('shortcuts.conflict', { action: other === undefined ? conflictId : t(other.labelKey) }),
        };
        return;
      }
    }
  }
  rowError.value = null;
  resetShortcutBinding(action.id);
}

function onResetAll(): void {
  // Defaults are internally consistent, so a full reset can never conflict.
  rowError.value = null;
  resetAllShortcutBindings();
}

// Modifier keyup during a recording: refresh (or clear) the live preview so
// the chip stops showing caps the user already released.
function onRecordKeyup(e: KeyboardEvent): void {
  if (recordingId.value === null) return;
  liveKeys.value = modifierKeysOf(e);
}

onMounted(() => document.addEventListener('keyup', onRecordKeyup, true));
onUnmounted(() => document.removeEventListener('keyup', onRecordKeyup, true));
// macOS close-hides the window instead of destroying it — the panel never
// unmounts, so a recording left open would keep the menu accelerators and the
// OS-level summon shortcut suspended while the window is hidden (exactly when
// the user needs the summon chord to bring it back). Cancel the recording on
// hide instead: the user returns to a clean row, not a half-open recorder.
function onVisibilityChange(): void {
  if (document.hidden && recordingId.value !== null) {
    stopRecording();
  }
}

onMounted(() => document.addEventListener('visibilitychange', onVisibilityChange));
onUnmounted(() => document.removeEventListener('visibilitychange', onVisibilityChange));
// The panel unmounts on a tab switch (v-if) even mid-recording — never leave
// the native menu or the global shortcut suspended behind our back.
onUnmounted(() => {
  setMenuSuspended(false);
  setGlobalShortcutSuspended(false);
});
</script>

<template>
  <div class="sc-panel">
    <label class="sc-search">
      <Icon name="search" size="md" />
      <input v-model="query" :placeholder="t('shortcuts.searchPlaceholder')" />
    </label>

    <section class="sec">
      <div class="sc-group">
        <div v-for="action in filteredActions" :key="action.id" class="sc-row">
          <span class="rlabel">
            {{ t(action.labelKey) }}
            <span class="hint">{{ t(action.descKey) }}</span>
            <span v-if="rowError?.id === action.id" class="hint sc-error">{{ rowError.message }}</span>
            <span v-else-if="recordingId === action.id && recordError !== null" class="hint sc-error">{{ recordError }}</span>
            <span v-else-if="osGlobalFailures[action.id]" class="hint sc-error">{{ t('shortcuts.globalTaken') }}</span>
          </span>
          <span class="sc-binding">
            <!-- Recording: a focused "press the shortcut" box + explicit
                 cancel (Esc also cancels). The reset/unassign buttons hide
                 while recording so the row only offers the way out. -->
            <template v-if="recordingId === action.id">
              <span class="sc-record-box">
                <Kbd v-if="liveKeys.length > 0" :keys="liveKeys" />
                <span v-else>{{ t('shortcuts.recording') }}</span>
              </span>
              <button type="button" class="sc-cancel" @click="stopRecording">
                {{ t('common.cancel') }}
              </button>
            </template>
            <template v-else>
              <Kbd v-if="bindingKeys(action.id).length > 0" :keys="bindingKeys(action.id)" />
              <span v-else class="sc-unassigned">{{ t('shortcuts.unassigned') }}</span>
              <IconButton size="sm" :label="t('shortcuts.edit')" @click="startRecording(action)">
                <Icon name="pencil" />
              </IconButton>
              <IconButton
                v-if="isShortcutCustomized(action.id)"
                size="sm"
                :label="t('shortcuts.reset')"
                @click="onReset(action)"
              >
                <Icon name="undo" />
              </IconButton>
              <IconButton
                v-else-if="resolvedBinding(action.id) !== null"
                size="sm"
                :label="t('shortcuts.unassign')"
                @click="setShortcutBinding(action.id, null)"
              >
                <Icon name="trash" />
              </IconButton>
            </template>
          </span>
        </div>
      </div>
    </section>

    <div class="sc-footer">
      <Button variant="secondary" size="sm" @click="onResetAll">
        <Icon name="undo" size="sm" />
        <span>{{ t('shortcuts.resetAll') }}</span>
      </Button>
    </div>
  </div>
</template>

<style scoped>
.sc-panel {
  display: flex;
  flex-direction: column;
  padding: var(--space-4) 0;
}
/* Mirrors the settings dialog's archive-search field. The negative inline
   margin matches .sc-group so both edges line up with the card below. */
.sc-search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 36px;
  padding: 0 var(--space-3);
  margin-bottom: var(--space-2);
  margin-inline: calc(-1 * var(--space-4));
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface-overlay);
  color: var(--color-text-faint);
  font-size: var(--text-sm);
  transition: border-color var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out);
}
.sc-search:focus-within {
  border-color: var(--color-accent);
  box-shadow: var(--p-focus-ring);
  color: var(--color-text-muted);
}
.sc-search input {
  width: 100%;
  border: none;
  outline: none;
  background: transparent;
  font: inherit;
  color: var(--color-text);
}
.sec {
  padding: var(--space-4) 0 0;
}
/* Mirrors the dialog's .settings-group card. */
.sc-group {
  overflow: hidden;
  margin-inline: calc(-1 * var(--space-4));
  border-radius: var(--radius-xl);
  background: var(--color-surface);
}
.sc-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: 52px;
  padding: var(--space-4);
  border-top: 0.5px solid var(--color-line);
}
.sc-row:first-child {
  border-top: none;
}
.rlabel {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  font-family: var(--font-ui);
  font-size: var(--text-base);
  font-weight: var(--weight-ui-strong);
  color: var(--color-text);
}
.hint {
  font-size: var(--text-xs);
  font-weight: var(--weight-regular);
  color: var(--color-text-faint);
}
.sc-error {
  color: var(--color-danger);
}
.sc-binding {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
}
/* Recording state: an accent-ringed box echoing the held modifier combo
   (or the prompt), with a plain cancel button beside it. The remaining px
   literals in this file (36px search field, 52px rows, 0.5px hairlines)
   deliberately mirror the surrounding SettingsDialog conventions; sizes with
   a token equivalent use the token. */
.sc-record-box {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 148px;
  height: var(--space-8);
  padding: 0 var(--space-4);
  border: 0.5px solid var(--color-accent);
  border-radius: var(--radius-lg);
  background: var(--color-surface-overlay);
  color: var(--color-text);
  font-size: var(--text-sm);
}
.sc-cancel {
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  padding: var(--space-1) var(--space-2);
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
}
.sc-cancel:hover {
  background: var(--color-hover);
  color: var(--color-text);
}
.sc-cancel:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.sc-unassigned {
  font-size: var(--text-sm);
  color: var(--color-text-faint);
}
.sc-error {
  color: var(--color-danger);
}
.sc-footer {
  display: flex;
  justify-content: flex-end;
  padding-top: var(--space-4);
  /* Same outward pull as the card, so the button ends at the card's edge. */
  margin-inline: calc(-1 * var(--space-4));
}
</style>
