<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch, type ComponentPublicInstance } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  Button,
  Dialog,
  Field,
  Icon,
  IconButton,
  Input,
  Menu,
  MenuItem,
  SegmentedControl,
  Textarea,
  menuNavigationIndex,
} from '@moonshot-ai/app-ui';
import { copyTextToClipboard } from '@moonshot-ai/app-core/lib';
import type { BrowserDataSnapshot, BrowserPreferencesPatch } from '../../../shared/browser-data';
import {
  BROWSER_USER_AGENT_MAX,
  BROWSER_USER_AGENT_PRESET_NAME_MAX,
  BROWSER_USER_AGENT_SAVED_PRESETS_MAX,
  browserUserAgentPresetNameError,
  browserUserAgentPresets,
  isBrowserCustomUserAgent,
  type BrowserUserAgentSavedPreset,
} from '../../../shared/browser-user-agent';
import { getNativeBrowserBridge } from '../../lib/nativeBrowser';
import { track } from '../../lib/track';

const props = defineProps<{ snapshot: BrowserDataSnapshot }>();
const emit = defineEmits<{ update: [snapshot: BrowserDataSnapshot] }>();
const { t } = useI18n();
const bridge = getNativeBrowserBridge();

const mode = ref<'default' | 'custom'>(props.snapshot.preferences.customUserAgent === null ? 'default' : 'custom');
const draft = ref(props.snapshot.preferences.customUserAgent ?? props.snapshot.defaultUserAgent);
const saving = ref(false);
const failed = ref(false);
const copied = ref(false);
const presetDialogOpen = ref(false);
const presetName = ref('');
const presetNameTouched = ref(false);
const presetSaveFailed = ref(false);
const presetDeleteFailed = ref(false);
const pendingDelete = ref<string | null>(null);
const presetMenuOpen = ref(false);
const presetTriggerRef = ref<ComponentPublicInstance | null>(null);
const presetMenuRef = ref<HTMLElement | null>(null);
const presetMenuStyle = ref<Record<string, string>>({});
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

onBeforeUnmount(() => clearTimeout(copiedTimer));

watch(() => props.snapshot.preferences.customUserAgent, (value) => {
  if (value !== null) {
    mode.value = 'custom';
    draft.value = value;
  } else if (!saving.value) {
    mode.value = 'default';
  }
});

const savedPresets = computed(() => props.snapshot.preferences.userAgentPresets);
const modeOptions = computed(() => [
  { value: 'default', label: t('browser.settings.userAgentDefault') },
  { value: 'custom', label: t('browser.settings.userAgentCustom') },
]);
const builtInPresets = computed(() => browserUserAgentPresets(props.snapshot.defaultUserAgent));
const builtInOptions = computed(() => builtInPresets.value.map(preset => ({
  value: `builtin:${preset.id}`,
  label: preset.platform === '' ? `${preset.label} ${preset.version}` : `${preset.label} ${preset.version} · ${preset.platform}`,
})));
const savedOptions = computed(() => savedPresets.value.map((preset, index) => ({
  value: `saved:${index}`,
  label: preset.name,
})));
const valid = computed(() => isBrowserCustomUserAgent(draft.value));
const dirty = computed(() => draft.value !== props.snapshot.preferences.customUserAgent);
const errorText = computed(() => {
  if (valid.value) return '';
  if (draft.value.length > BROWSER_USER_AGENT_MAX) return t('browser.settings.userAgentTooLong', { max: BROWSER_USER_AGENT_MAX });
  return /[\r\n]/.test(draft.value) ? t('browser.settings.userAgentNewline') : t('browser.settings.userAgentInvalid');
});
const presetNameError = computed(() => browserUserAgentPresetNameError(presetName.value, savedPresets.value));
const presetNameErrorText = computed(() => {
  switch (presetNameError.value) {
    case 'full': return t('browser.settings.userAgentPresetsFull', { max: BROWSER_USER_AGENT_SAVED_PRESETS_MAX });
    case 'tooLong': return t('browser.settings.userAgentPresetNameTooLong', { max: BROWSER_USER_AGENT_PRESET_NAME_MAX });
    case 'invalid': return t('browser.settings.userAgentPresetNameInvalid');
    case 'duplicate': return t('browser.settings.userAgentPresetNameDuplicate');
    case 'empty': return presetNameTouched.value ? t('browser.settings.userAgentPresetNameEmpty') : '';
    default:
      if (!valid.value) return errorText.value;
      return presetSaveFailed.value ? t('browser.settings.userAgentPresetSaveFailed') : '';
  }
});

function plainSavedPresets(): BrowserUserAgentSavedPreset[] {
  return savedPresets.value.map(preset => ({ name: preset.name, value: preset.value }));
}

function patchApplied(patch: BrowserPreferencesPatch, next: BrowserDataSnapshot): boolean {
  if (patch.customUserAgent !== undefined && next.preferences.customUserAgent !== patch.customUserAgent) return false;
  if (patch.userAgentPresets === undefined) return true;
  const saved = next.preferences.userAgentPresets;
  return saved.length === patch.userAgentPresets.length
    && patch.userAgentPresets.every((preset, index) => saved[index]?.name === preset.name && saved[index]?.value === preset.value);
}

async function patchPreferences(patch: BrowserPreferencesPatch): Promise<boolean> {
  if (bridge === null) return false;
  saving.value = true;
  try {
    const next = await bridge.browserUpdatePreferences(patch);
    emit('update', next);
    return patchApplied(patch, next);
  } catch {
    return false;
  } finally {
    saving.value = false;
  }
}

async function update(customUserAgent: string | null): Promise<void> {
  if (bridge === null) return;
  failed.value = false;
  failed.value = !(await patchPreferences({ customUserAgent }));
  if (!failed.value) {
    track('settings_changed', { key: 'browser-user-agent', value: customUserAgent === null ? 'default' : 'custom', source_panel: 'settings' });
  }
}

function setMode(value: string): void {
  if (value === 'custom') {
    mode.value = 'custom';
    if (props.snapshot.preferences.customUserAgent === null) draft.value = props.snapshot.defaultUserAgent;
  } else if (value === 'default') {
    void resetToDefault();
  }
}

async function resetToDefault(): Promise<void> {
  const previousDraft = draft.value;
  mode.value = 'default';
  draft.value = props.snapshot.defaultUserAgent;
  if (props.snapshot.preferences.customUserAgent === null) return;
  await update(null);
  if (failed.value && props.snapshot.preferences.customUserAgent !== null) {
    mode.value = 'custom';
    draft.value = previousDraft;
  }
}

function applyPreset(value: string): void {
  const [kind, key] = value.split(':');
  const preset = kind === 'builtin'
    ? builtInPresets.value.find(entry => entry.id === key)
    : savedPresets.value[Number(key)];
  pendingDelete.value = null;
  if (preset !== undefined) draft.value = preset.value;
}

function save(): void {
  if (valid.value && dirty.value) void update(draft.value);
}

async function copyDefault(): Promise<void> {
  if (!(await copyTextToClipboard(props.snapshot.defaultUserAgent))) return;
  copied.value = true;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => { copied.value = false; }, 1500);
}

function openPresetDialog(): void {
  presetName.value = '';
  presetNameTouched.value = false;
  presetSaveFailed.value = false;
  presetDialogOpen.value = true;
}

async function savePreset(): Promise<void> {
  presetNameTouched.value = true;
  presetSaveFailed.value = false;
  if (presetNameError.value !== null || !valid.value) return;
  const next = [...plainSavedPresets(), { name: presetName.value.trim(), value: draft.value }];
  if (await patchPreferences({ userAgentPresets: next })) {
    presetDialogOpen.value = false;
    track('settings_changed', { key: 'browser-user-agent-presets', value: 'added', source_panel: 'settings' });
  } else {
    presetSaveFailed.value = true;
  }
}

function presetTrigger(): HTMLElement | null {
  return (presetTriggerRef.value?.$el as HTMLElement | undefined) ?? null;
}

function presetItems(): HTMLElement[] {
  return [...(presetMenuRef.value?.querySelectorAll<HTMLElement>('.ui-menu-item') ?? [])];
}

function focusPresetItem(index: number): void {
  const items = presetItems();
  items[Math.max(0, Math.min(index, items.length - 1))]?.focus();
}

async function openPresetMenu(focus: 'first' | 'last' = 'first'): Promise<void> {
  if (presetMenuOpen.value) {
    focusPresetItem(focus === 'first' ? 0 : presetItems().length - 1);
    return;
  }
  if (saving.value) return;
  pendingDelete.value = null;
  presetMenuOpen.value = true;
  window.addEventListener('mousedown', onPresetPointerDown, true);
  window.addEventListener('keydown', onPresetEscape, true);
  window.addEventListener('resize', positionPresetMenu);
  window.addEventListener('scroll', positionPresetMenu, true);
  await nextTick();
  positionPresetMenu();
  focusPresetItem(focus === 'first' ? 0 : presetItems().length - 1);
}

function closePresetMenu({ refocus = false } = {}): void {
  if (!presetMenuOpen.value) return;
  presetMenuOpen.value = false;
  pendingDelete.value = null;
  window.removeEventListener('mousedown', onPresetPointerDown, true);
  window.removeEventListener('keydown', onPresetEscape, true);
  window.removeEventListener('resize', positionPresetMenu);
  window.removeEventListener('scroll', positionPresetMenu, true);
  if (refocus) presetTrigger()?.focus();
}

function togglePresetMenu(): void {
  if (presetMenuOpen.value) closePresetMenu();
  else void openPresetMenu();
}

function positionPresetMenu(): void {
  const trigger = presetTrigger();
  const surface = presetMenuRef.value?.querySelector<HTMLElement>('.ui-menu');
  if (!trigger || !surface) return;
  const rect = trigger.getBoundingClientRect();
  const rootStyle = getComputedStyle(document.documentElement);
  const edge = Number.parseFloat(rootStyle.getPropertyValue('--space-2')) || 8;
  const gap = Number.parseFloat(rootStyle.getPropertyValue('--space-1')) || 4;
  const height = surface.scrollHeight + surface.offsetHeight - surface.clientHeight;
  const below = window.innerHeight - edge - rect.bottom - gap;
  const above = rect.top - gap - edge;
  const flipUp = below < height && above > below;
  const left = Math.max(edge, Math.min(rect.left, window.innerWidth - edge - surface.offsetWidth));
  presetMenuStyle.value = flipUp
    ? { left: `${left}px`, bottom: `${window.innerHeight - rect.top + gap}px`, maxHeight: `${Math.max(0, above)}px` }
    : { left: `${left}px`, top: `${rect.bottom + gap}px`, maxHeight: `${Math.max(0, below)}px` };
}

function onPresetPointerDown(event: MouseEvent): void {
  const target = event.target as Node | null;
  if (!target || presetMenuRef.value?.contains(target) || presetTrigger()?.contains(target)) return;
  closePresetMenu();
}

function onPresetEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopImmediatePropagation();
  closePresetMenu({ refocus: true });
}

function onPresetMenuKeydown(event: KeyboardEvent): void {
  const active = document.activeElement as HTMLElement | null;
  const row = active?.closest<HTMLElement>('.ui-menu-item-row') ?? null;
  const item = active?.classList.contains('ui-menu-item') ? active : row?.querySelector<HTMLElement>('.ui-menu-item') ?? null;
  const items = presetItems();
  if (event.key === 'Tab') {
    event.preventDefault();
    event.stopPropagation();
    const action = row?.querySelector<HTMLElement>('.ui-menu-item__action button:not(:disabled)') ?? null;
    if (active === item && !event.shiftKey && action) action.focus();
    else if (active !== item && event.shiftKey && item) item.focus();
    else closePresetMenu({ refocus: true });
    return;
  }
  const next = menuNavigationIndex(event.key, event.shiftKey, item ? items.indexOf(item) : -1, items.length);
  if (next === null) return;
  event.preventDefault();
  event.stopPropagation();
  focusPresetItem(next);
}

function choosePreset(value: string): void {
  applyPreset(value);
  closePresetMenu({ refocus: true });
}

function requestDelete(value: string, event: MouseEvent): void {
  pendingDelete.value = value;
  presetDeleteFailed.value = false;
  const action = (event.currentTarget as HTMLElement | null)?.parentElement;
  void nextTick(() => action?.querySelector<HTMLButtonElement>('.bua-confirm-delete')?.focus());
}

async function deletePreset(value: string): Promise<void> {
  const index = Number(value.slice('saved:'.length));
  const position = builtInOptions.value.length + index;
  pendingDelete.value = null;
  const next = plainSavedPresets().filter((_, entry) => entry !== index);
  presetDeleteFailed.value = !(await patchPreferences({ userAgentPresets: next }));
  if (!presetDeleteFailed.value) track('settings_changed', { key: 'browser-user-agent-presets', value: 'removed', source_panel: 'settings' });
  await nextTick();
  if (!presetMenuOpen.value) return;
  positionPresetMenu();
  focusPresetItem(position);
}

watch(mode, () => closePresetMenu());
onBeforeUnmount(() => closePresetMenu());
</script>

<template>
  <div class="settings-group bua-group">
    <div class="row">
      <span class="rlabel">
        {{ t('browser.settings.userAgent') }}
        <small>{{ t('browser.settings.userAgentHint') }}</small>
      </span>
      <SegmentedControl
        size="xs"
        :model-value="mode"
        :options="modeOptions"
        :disabled="saving"
        :aria-label="t('browser.settings.userAgent')"
        @update:model-value="setMode"
      />
    </div>
    <div class="row bua-editor">
      <template v-if="mode === 'default'">
        <div class="bua-readonly-block">
          <p
            class="bua-readonly"
            role="textbox"
            aria-readonly="true"
            :aria-label="t('browser.settings.userAgentDefaultValue')"
          >{{ snapshot.defaultUserAgent }}</p>
          <IconButton
            size="sm"
            class="bua-copy"
            :label="copied ? t('browser.settings.userAgentCopied') : t('browser.settings.userAgentCopy')"
            :tooltip="copied ? t('browser.settings.userAgentCopied') : t('browser.settings.userAgentCopy')"
            @click="copyDefault"
          >
            <Icon :name="copied ? 'check' : 'copy'" size="sm" />
          </IconButton>
        </div>
      </template>
      <template v-else>
        <Textarea
          v-model="draft"
          class="bua-value"
          size="sm"
          :rows="2"
          autosize
          :error="!valid"
          :disabled="saving"
          :placeholder="t('browser.settings.userAgentPlaceholder')"
          :aria-label="t('browser.settings.userAgentCustomValue')"
        />
        <p v-if="!valid" class="bua-error" role="alert">{{ errorText }}</p>
        <p v-else-if="failed" class="bua-error" role="alert">{{ t('browser.settings.userAgentSaveFailed') }}</p>
        <p v-if="presetDeleteFailed" class="bua-error" role="alert">{{ t('browser.settings.userAgentPresetDeleteFailed') }}</p>
        <div class="bua-actions">
          <span class="bua-preset-actions">
            <Button
              ref="presetTriggerRef"
              size="sm"
              variant="secondary"
              class="bua-load-preset"
              aria-haspopup="menu"
              :aria-expanded="presetMenuOpen"
              :disabled="saving && !presetMenuOpen"
              @click="togglePresetMenu"
              @keydown.down.prevent="openPresetMenu('first')"
              @keydown.up.prevent="openPresetMenu('last')"
            >
              {{ t('browser.settings.userAgentLoadPreset') }}
            </Button>
            <Button size="sm" variant="secondary" class="bua-save-preset" :disabled="saving || !valid" @click="openPresetDialog">
              {{ t('browser.settings.userAgentSavePreset') }}
            </Button>
          </span>
          <Teleport to="body">
            <div
              v-if="presetMenuOpen"
              ref="presetMenuRef"
              class="bua-preset-menu"
              :style="presetMenuStyle"
              @keydown="onPresetMenuKeydown"
            >
              <Menu :aria-label="t('browser.settings.userAgentLoadPreset')">
                <div class="bua-preset-group" role="presentation">{{ t('browser.settings.userAgentPresetBuiltIn') }}</div>
                <MenuItem v-for="option in builtInOptions" :key="option.value" @click="choosePreset(option.value)">
                  <span class="bua-preset-label">{{ option.label }}</span>
                </MenuItem>
                <template v-if="savedOptions.length > 0">
                  <div class="bua-preset-group" role="presentation">{{ t('browser.settings.userAgentPresetSaved') }}</div>
                  <MenuItem v-for="option in savedOptions" :key="option.value" @click="choosePreset(option.value)">
                    <span class="bua-preset-label">{{ option.label }}</span>
                    <template #action>
                      <Button
                        v-if="pendingDelete === option.value"
                        size="xs"
                        variant="danger"
                        class="bua-confirm-delete"
                        :aria-label="t('browser.settings.userAgentConfirmDeletePreset', { name: option.label })"
                        :disabled="saving"
                        @click="deletePreset(option.value)"
                      >
                        {{ t('browser.settings.userAgentDeletePresetConfirm') }}
                      </Button>
                      <IconButton
                        v-else
                        size="sm"
                        class="bua-delete-preset"
                        :label="t('browser.settings.userAgentDeletePreset', { name: option.label })"
                        :disabled="saving"
                        @click="requestDelete(option.value, $event)"
                      >
                        <Icon name="trash" size="sm" />
                      </IconButton>
                    </template>
                  </MenuItem>
                </template>
              </Menu>
            </div>
          </Teleport>
          <Button size="sm" variant="secondary" :disabled="saving" @click="resetToDefault">
            {{ t('browser.settings.userAgentReset') }}
          </Button>
          <Button size="sm" class="bua-apply" :disabled="saving || !valid || !dirty" @click="save">
            {{ t('browser.settings.userAgentApply') }}
          </Button>
        </div>
      </template>
    </div>
    <Dialog
      v-model:open="presetDialogOpen"
      size="sm"
      initial-focus="input"
      :title="t('browser.settings.userAgentSavePresetTitle')"
    >
      <form class="bua-preset-form" @submit.prevent="savePreset">
        <Field :label="t('browser.settings.userAgentPresetName')" :error="presetNameErrorText">
          <Input
            v-model="presetName"
            class="bua-preset-name"
            size="sm"
            :error="presetNameErrorText !== ''"
            :placeholder="t('browser.settings.userAgentPresetNamePlaceholder')"
            :aria-label="t('browser.settings.userAgentPresetName')"
          />
        </Field>
        <p class="bua-preset-preview">{{ draft }}</p>
      </form>
      <template #foot>
        <Button size="sm" variant="secondary" @click="presetDialogOpen = false">{{ t('common.cancel') }}</Button>
        <Button size="sm" class="bua-preset-submit" :disabled="saving || presetNameError !== null" @click="savePreset">
          {{ t('browser.settings.userAgentPresetSave') }}
        </Button>
      </template>
    </Dialog>
  </div>
</template>

<style scoped src="@moonshot-ai/app-components/settings-common.css"></style>

<style scoped>
.bua-group {
  margin-top: var(--space-4);
}
.bua-group > .row {
  min-height: var(--browser-settings-row-min-height);
}
.bua-group > .row:first-child > .rlabel {
  flex: 1;
  min-width: 0;
}
.bua-editor {
  flex-direction: column;
  align-items: stretch;
}
.bua-value {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  word-break: break-all;
}
.bua-readonly,
.bua-preset-preview {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--color-fill-2);
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: 1.5;
  word-break: break-all;
  user-select: text;
}
.bua-readonly-block {
  position: relative;
}
.bua-readonly {
  padding-inline-end: calc(var(--icon-button-sm) + var(--space-3));
  cursor: default;
}
.bua-copy {
  position: absolute;
  top: var(--space-1);
  right: var(--space-1);
}
.bua-error {
  margin: 0;
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  color: var(--color-danger);
}
.bua-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
}
.bua-preset-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-inline-end: auto;
}
.bua-preset-menu {
  position: fixed;
  z-index: var(--z-modal-dropdown);
  display: flex;
  flex-direction: column;
}
.bua-preset-menu :deep(.ui-menu) {
  max-width: min(360px, calc(100vw - 2 * var(--space-2)));
  max-height: inherit;
  overflow-y: auto;
}
.bua-preset-group {
  padding: var(--space-2) var(--space-2) var(--space-1);
  color: var(--color-text-faint);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  user-select: none;
}
.bua-preset-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bua-preset-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
</style>
