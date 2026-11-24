<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, Icon, IconButton, Kbd } from '@moonshot-ai/app-ui';
import { bindingKeyNames, formatShortcutText, isApplePlatform } from '@moonshot-ai/app-core/lib';
import {
  bindingFromEvent,
  findConflict,
  isAcceleratorExpressible,
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
  setGlobalShortcutRecording,
  useShortcutOverrides,
} from '../../composables/useShortcuts';
import { track } from '../../lib/track';
import type { ShortcutActionId } from '../../../shared/action-ids';

const { t } = useI18n();
const props = defineProps<{ initialAction?: ShortcutActionId }>();
const overrides = useShortcutOverrides();
const screenshotSupported = (
  window as { kimiDesktop?: { isScreenshotSupported?: () => boolean } }
).kimiDesktop?.isScreenshotSupported?.() === true;

const initialAction = props.initialAction ? shortcutActionById(props.initialAction) : undefined;
const query = ref(initialAction ? t(initialAction.labelKey) : '');
const recordingId = ref<ShortcutActionId | null>(null);
const recordError = ref<string | null>(null);
const rowError = ref<{ id: string; message: string } | null>(null);
const liveKeys = ref<string[]>([]);
const saving = ref(false);

function modifierKeysOf(e: KeyboardEvent): string[] {
  const isApple = isApplePlatform();
  const keys: string[] = [];
  if (isApple && e.ctrlKey) keys.push('ctrl');
  if (e.altKey) keys.push('alt');
  if (e.shiftKey) keys.push('shift');
  if (isApple ? e.metaKey : e.ctrlKey) keys.push('mod');
  return keys;
}

function matchesQuery(action: ShortcutAction, q: string): boolean {
  if (q === '') return true;
  if (t(action.labelKey).toLowerCase().includes(q)) return true;
  if (t(action.descKey).toLowerCase().includes(q)) return true;
  const binding = resolvedBinding(action.id);
  return binding !== null && formatShortcutText(binding).join(' ').toLowerCase().includes(q);
}

const filteredActions = computed(() => {
  const q = query.value.trim().toLowerCase();
  return SHORTCUT_ACTIONS.filter((action) => (action.id !== 'captureScreenshot' || screenshotSupported) && matchesQuery(action, q));
});

function bindingKeys(id: string): string[] {
  const binding = resolvedBinding(id);
  return binding === null ? [] : bindingKeyNames(binding);
}

function startRecording(action: ShortcutAction): void {
  recordingId.value = action.id;
  recordError.value = null;
  rowError.value = null;
  liveKeys.value = [];
  setMenuSuspended(true);
  void setGlobalShortcutRecording(true);
}

function stopRecording(): void {
  recordingId.value = null;
  recordError.value = null;
  liveKeys.value = [];
  setMenuSuspended(false);
  void setGlobalShortcutRecording(false);
}

interface MenuSuspendBridge {
  setMenuSuspended?: (suspended: boolean) => void;
}

function setMenuSuspended(suspended: boolean): void {
  (window as { kimiDesktop?: MenuSuspendBridge }).kimiDesktop?.setMenuSuspended?.(suspended);
}

async function finishOsGlobalRecording(
  id: ShortcutActionId,
): Promise<boolean> {
  saving.value = true;
  recordingId.value = null;
  await setGlobalShortcutRecording(false);
  saving.value = false;
  recordError.value = null;
  liveKeys.value = [];
  setMenuSuspended(false);
  if (rowError.value?.id === id) rowError.value = null;
  return !osGlobalFailures[id];
}

function osGlobalFailureMessage(id: string): string {
  const reason = osGlobalFailures[id];
  if (reason === 'channel-disabled') return t('shortcuts.channelDisabled');
  if (reason === 'invalid') return t('shortcuts.invalid');
  return t('shortcuts.globalTaken');
}

function onRecordKeydown(e: KeyboardEvent): void {
  const id = recordingId.value;
  if (id === null) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
    stopRecording();
    return;
  }
  const action = shortcutActionById(id);
  if (action === undefined) {
    stopRecording();
    return;
  }
  if (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph')) {
    recordError.value = t('shortcuts.invalid');
    liveKeys.value = [];
    return;
  }
  const binding = bindingFromEvent(e);
  if (binding === null) {
    liveKeys.value = modifierKeysOf(e);
    return;
  }
  const menuBacked = MENU_SYNCED_ACTIONS.includes(id);
  if (!isValidBinding(binding, action.scope) || (menuBacked && !isValidMenuBinding(binding))) {
    recordError.value = t('shortcuts.invalid');
    liveKeys.value = [];
    return;
  }
  if (OS_GLOBAL_ACTIONS.includes(id) && (!isValidMenuBinding(binding) || !isAcceleratorExpressible(binding))) {
    recordError.value = t('shortcuts.notGlobal');
    liveKeys.value = [];
    return;
  }
  if (isReservedBinding(binding, id)) {
    recordError.value = t('shortcuts.reserved');
    liveKeys.value = [];
    return;
  }
  if (isHardcodedBinding(binding)) {
    recordError.value = t('shortcuts.reservedSteer');
    liveKeys.value = [];
    return;
  }
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
  setShortcutBinding(id, binding);
  if (OS_GLOBAL_ACTIONS.includes(id)) {
    void finishOsGlobalRecording(id).then((ok) => {
      if (ok) track('shortcut_binding_changed', { action: id, op: 'assign' });
    });
    return;
  }
  track('shortcut_binding_changed', { action: id, op: 'assign' });
  stopRecording();
}

onMounted(() => document.addEventListener('keydown', onRecordKeydown, true));
onUnmounted(() => document.removeEventListener('keydown', onRecordKeydown, true));

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
  track('shortcut_binding_changed', { action: action.id, op: 'reset' });
}

function onClear(action: ShortcutAction): void {
  setShortcutBinding(action.id, null);
  track('shortcut_binding_changed', { action: action.id, op: 'clear' });
}

function onResetAll(): void {
  rowError.value = null;
  resetAllShortcutBindings();
  track('shortcut_binding_changed', { action: '*', op: 'reset_all' });
}

function onRecordKeyup(e: KeyboardEvent): void {
  if (recordingId.value === null) return;
  liveKeys.value = modifierKeysOf(e);
}

onMounted(() => document.addEventListener('keyup', onRecordKeyup, true));
onUnmounted(() => document.removeEventListener('keyup', onRecordKeyup, true));
function onVisibilityChange(): void {
  if (document.hidden && recordingId.value !== null) {
    stopRecording();
  }
}

onMounted(() => document.addEventListener('visibilitychange', onVisibilityChange));
onUnmounted(() => document.removeEventListener('visibilitychange', onVisibilityChange));
onUnmounted(() => {
  setMenuSuspended(false);
  void setGlobalShortcutRecording(false);
});
</script>

<template>
  <div class="sc-panel">
    <h3 class="sec-title">{{ t('settings.tabs.shortcuts') }}</h3>

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
            <span v-else-if="osGlobalFailures[action.id]" class="hint sc-error">{{ osGlobalFailureMessage(action.id) }}</span>
          </span>
          <span class="sc-binding">
            <template v-if="recordingId === action.id">
              <span class="sc-record-box">
                <Kbd v-if="liveKeys.length > 0" :keys="liveKeys" />
                <span v-else>{{ t('shortcuts.recording') }}</span>
              </span>
              <Button variant="ghost" size="xs" @click="stopRecording">
                {{ t('common.cancel') }}
              </Button>
            </template>
            <template v-else>
              <Kbd v-if="bindingKeys(action.id).length > 0" :keys="bindingKeys(action.id)" />
              <span v-else class="sc-unassigned">{{ t('shortcuts.unassigned') }}</span>
              <IconButton size="sm" :disabled="saving || recordingId !== null" :label="t('shortcuts.edit')" :tooltip="t('shortcuts.edit')" @click="startRecording(action)">
                <Icon name="pencil" />
              </IconButton>
              <IconButton
                v-if="isShortcutCustomized(action.id)"
                size="sm"
                :disabled="saving || recordingId !== null"
                :label="t('shortcuts.reset')"
                :tooltip="t('shortcuts.reset')"
                @click="onReset(action)"
              >
                <Icon name="undo" />
              </IconButton>
              <IconButton
                v-else-if="resolvedBinding(action.id) !== null"
                size="sm"
                :disabled="saving || recordingId !== null"
                :label="t('shortcuts.unassign')"
                :tooltip="t('shortcuts.unassign')"
                @click="onClear(action)"
              >
                <Icon name="trash" />
              </IconButton>
            </template>
          </span>
        </div>
      </div>
    </section>

    <div class="sc-footer">
      <Button variant="secondary" size="sm" :disabled="saving || recordingId !== null" @click="onResetAll">
        <Icon name="undo" size="sm" />
        <span>{{ t('shortcuts.resetAll') }}</span>
      </Button>
    </div>
  </div>
</template>

<style scoped src="@moonshot-ai/app-components/settings-common.css"></style>

<style scoped>
.sc-panel {
  display: flex;
  flex-direction: column;
  padding: 0 0 var(--space-4);
}
.sc-search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 36px;
  padding: 0 var(--space-3);
  margin-bottom: var(--space-2);
  border: var(--p-hairline) solid var(--color-line);
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
.sc-group {
  overflow: hidden;
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
  border-top: var(--p-hairline) solid var(--color-line);
}
.sc-row:first-child {
  border-top: none;
}
.hint {
  font-size: var(--text-xs);
  font-weight: var(--weight-regular);
  line-height: var(--leading-normal);
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
.sc-record-box {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 148px;
  height: var(--space-8);
  padding: 0 var(--space-4);
  border: var(--p-hairline) solid var(--color-accent);
  border-radius: var(--radius-lg);
  background: var(--color-surface-overlay);
  color: var(--color-text);
  font-size: var(--text-sm);
}
.sc-unassigned {
  font-size: var(--text-sm);
  color: var(--color-text-faint);
}
.sc-footer {
  display: flex;
  justify-content: flex-end;
  padding-top: var(--space-4);
}
</style>
