<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  effectiveFontPrefs,
  FONT_FOLLOWS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  ensureLocalFontsIfPermitted,
  fontFamilyKind,
  fontModes,
  kimiCodeFontFamilies,
  localFontSearchNames,
  systemFontKeyword,
  useFontPrefs,
  useLocalFonts,
  type FontMode,
  type FontTarget,
} from '@moonshot-ai/app-core';
import { bundledFontsOfKind, getBundledFont, isDesktop, isWindowsDesktop } from '@moonshot-ai/app-core/lib';
import { installImeCompositionLatch, isImeKeyEvent, movedOrder } from '@moonshot-ai/app-client/lib';
import { useFontMetadata, useWrapReorderDrag } from '@moonshot-ai/app-client/composables';
import { track } from '@moonshot-ai/app-client/contracts';
import {
  Badge,
  Icon,
  IconButton,
  Menu,
  MenuItem,
  NumberInput,
  RadioCardGroup,
  Spinner,
} from '@moonshot-ai/app-ui';
import FontOptionPreview from './FontOptionPreview.vue';
import SettingsSubpage from './SettingsSubpage.vue';
import {
  FONT_CHIP_ORIGINS,
  FONT_HINT_KEYS,
  FONT_TITLE_KEYS,
  fontChipOrigin,
  useFontFamilyLabel,
} from './fontSettingsLabels';
import FontSettingsPreview from './FontSettingsPreview.vue';

const props = withDefaults(defineProps<{ target: FontTarget; sourcePanel?: 'settings' | 'mobile_settings' }>(), {
  sourcePanel: 'settings',
});
const emit = defineEmits<{ back: [] }>();

const { t, locale } = useI18n();
const displayFamily = useFontFamilyLabel();
const { fontMetadata, ensureFontMetadata } = useFontMetadata();
installImeCompositionLatch();
const { fontPrefs, setFontPref } = useFontPrefs();
const { localFontFamilies, localFontsState, ensureLocalFonts } = useLocalFonts();

const MONO_TARGETS: readonly FontTarget[] = ['code', 'terminal'];

const prefs = computed(() => fontPrefs.value[props.target]);
const families = computed(() => prefs.value.families);
const mode = computed(() => prefs.value.mode);
const followSource = FONT_FOLLOWS[props.target];
const followLabel = computed(() => t(followSource === 'code' ? 'settings.fontFollowCode' : 'settings.fontFollowUi'));
const MODE_LABEL_KEYS: Record<Exclude<FontMode, 'same'>, string> = {
  system: 'settings.fontSystemDefault',
  kimi: 'settings.fontKimiDefault',
  custom: 'settings.fontModeCustom',
};
const isMonoTarget = MONO_TARGETS.includes(props.target);
const MODE_DESCRIPTION_KEYS: Record<FontMode, string> = {
  same: followSource === 'code' ? 'settings.fontModeSameCodeDesc' : 'settings.fontModeSameUiDesc',
  system: isMonoTarget ? 'settings.fontModeSystemCodeDesc' : 'settings.fontModeSystemDesc',
  kimi: isMonoTarget ? 'settings.fontModeKimiCodeDesc' : 'settings.fontModeKimiDesc',
  custom: 'settings.fontModeCustomDesc',
};
function modeDescription(value: FontMode): string {
  const description = t(MODE_DESCRIPTION_KEYS[value]);
  if (value !== 'system' || !isWindowsDesktop) return description;
  return `${description}${locale.value === 'zh' ? '' : ' '}${t('settings.fontModeSystemWindowsDesc')}`;
}
const modeOptions = computed(() =>
  fontModes(props.target).map((value) => ({
    value,
    label: value === 'same' ? followLabel.value : t(MODE_LABEL_KEYS[value]),
    description: modeDescription(value),
  })),
);

const draftText = ref('');
const comboOpen = ref(false);
const activeIndex = ref(-1);
const listboxId = `fs-fonts-${Math.random().toString(36).slice(2, 9)}`;
const modeLabelId = `${listboxId}-mode`;
const menuRef = ref<{ el?: HTMLElement }>();
const fieldRef = ref<HTMLElement>();
const tokenInputRef = ref<HTMLInputElement>();

const MENU_GAP = 4;
const MENU_MARGIN = 8;
const MENU_MAX_HEIGHT = 240;
const menuStyle = ref<Record<string, string>>({});

function positionMenu(): void {
  const field = fieldRef.value;
  const menu = menuRef.value?.el;
  if (!field || !menu) return;
  const r = field.getBoundingClientRect();
  const vh = window.innerHeight;
  const contentH = menu.offsetHeight;
  const spaceBelow = vh - MENU_MARGIN - (r.bottom + MENU_GAP);
  const spaceAbove = r.top - MENU_GAP - MENU_MARGIN;
  const up = contentH > spaceBelow && spaceAbove > spaceBelow;
  const maxH = Math.max(96, Math.min(MENU_MAX_HEIGHT, up ? spaceAbove : spaceBelow));
  const finalH = Math.min(contentH, maxH);
  menuStyle.value = {
    top: up ? `${Math.round(r.top - MENU_GAP - finalH)}px` : `${Math.round(r.bottom + MENU_GAP)}px`,
    left: `${Math.round(r.left)}px`,
    width: `${Math.round(r.width)}px`,
    maxHeight: `${Math.round(maxH)}px`,
  };
}

watch(comboOpen, (isOpen) => {
  if (isOpen) void nextTick(positionMenu);
});

function onScrollOrResize(event: Event): void {
  if (event.target instanceof Node && menuRef.value?.el?.contains(event.target)) return;
  comboOpen.value = false;
  activeIndex.value = -1;
}

onMounted(() => {
  window.addEventListener('scroll', onScrollOrResize, true);
  window.addEventListener('resize', onScrollOrResize);
  void ensureLocalFontsIfPermitted();
});
onUnmounted(() => {
  window.removeEventListener('scroll', onScrollOrResize, true);
  window.removeEventListener('resize', onScrollOrResize);
});

const FONT_MENU_PAGE_SIZE = 60;
const visibleFamilyCount = ref(FONT_MENU_PAGE_SIZE);
const fontsLoading = computed(() => localFontsState.value === 'querying');

function isSelectedFamily(family: string): boolean {
  const bundled = getBundledFont(family);
  return families.value.some((selected) =>
    bundled ? getBundledFont(selected)?.family === bundled.family : selected.toLowerCase() === family.toLowerCase(),
  );
}

function matchesQuery(family: string): boolean {
  const needle = draftText.value.trim().toLowerCase();
  if (
    needle === '' ||
    family.toLowerCase().includes(needle) ||
    displayFamily(family).toLowerCase().includes(needle) ||
    [...localFontSearchNames(family)].some((name) => name.includes(needle))
  ) {
    return true;
  }
  return (
    fontMetadata.value[family]?.metadata?.names.some(
      (record) => [1, 4, 16].includes(record.id) && record.text.toLowerCase().includes(needle),
    ) ?? false
  );
}

const bundledMatches = computed(() =>
  bundledFontsOfKind(isMonoTarget ? 'mono' : 'sans').filter(matchesQuery),
);
const systemKeyword = systemFontKeyword(props.target);
const systemMatches = computed(() => [
  ...(matchesQuery(systemKeyword) ? [systemKeyword] : []),
  ...localFontFamilies.value.filter(
    (family) =>
      !getBundledFont(family) &&
      fontFamilyKind(family) === 'font' &&
      !isSelectedFamily(family) &&
      matchesQuery(family),
  ),
]);
const familyMatches = computed(() => [...bundledMatches.value, ...systemMatches.value]);
const visibleFamilyMatches = computed(() => familyMatches.value.slice(0, visibleFamilyCount.value));
const addCandidate = computed(() => {
  const typed = draftText.value.trim();
  if (typed === '' || fontFamilyKind(typed) === 'generic' || isSelectedFamily(typed)) return null;
  const needle = typed.toLowerCase();
  const listed = familyMatches.value.some(
    (family) => family.toLowerCase() === needle || displayFamily(family).toLowerCase() === needle,
  );
  return listed ? null : typed;
});
const addIndex = computed(() => (addCandidate.value === null ? -1 : familyMatches.value.length));
const showUnavailableNote = computed(() => !isDesktop && localFontsState.value === 'unavailable');
const enabledIndexes = computed(() => [
  ...familyMatches.value.flatMap((family, index) => (isSelectedFamily(family) ? [] : [index])),
  ...(addIndex.value >= 0 ? [addIndex.value] : []),
]);
const menuVisible = computed(
  () =>
    comboOpen.value &&
    (fontsLoading.value || familyMatches.value.length > 0 || addCandidate.value !== null || showUnavailableNote.value),
);

watch(
  [localFontsState, families],
  () => {
    if (localFontsState.value === 'idle' && families.value.length > 0) ensureLocalFonts();
    if (localFontsState.value === 'ready') {
      for (const family of families.value) void ensureFontMetadata(family);
    }
  },
  { immediate: true },
);

watch([draftText, families], () => {
  visibleFamilyCount.value = FONT_MENU_PAGE_SIZE;
  activeIndex.value = -1;
  if (menuRef.value?.el) menuRef.value.el.scrollTop = 0;
});

watch([draftText, familyMatches, addCandidate, menuVisible], () => {
  if (comboOpen.value) void nextTick(positionMenu);
});

watch(familyMatches, (next, previous) => {
  if (activeIndex.value >= previous.length) {
    activeIndex.value = addIndex.value;
    return;
  }
  const active = previous[activeIndex.value];
  if (active === undefined) return;
  activeIndex.value = next.indexOf(active);
  visibleFamilyCount.value = Math.max(visibleFamilyCount.value, activeIndex.value + 1);
});

function onMenuScroll(): void {
  const menu = menuRef.value?.el;
  if (!menu || menu.scrollTop + menu.clientHeight < menu.scrollHeight - menu.clientHeight) return;
  visibleFamilyCount.value = Math.max(
    FONT_MENU_PAGE_SIZE,
    Math.min(familyMatches.value.length, visibleFamilyCount.value + FONT_MENU_PAGE_SIZE),
  );
}

const chipOrigins = computed(() =>
  families.value.map((family) => {
    const origin = fontChipOrigin(family, localFontFamilies.value, localFontsState.value);
    return origin === null ? null : FONT_CHIP_ORIGINS[origin];
  }),
);

function setFamilies(next: readonly string[]): void {
  setFontPref(props.target, { families: [...next] });
}

function prefillFamilies(from: FontMode): string[] {
  if (from === 'kimi') return kimiCodeFontFamilies(props.target);
  if (from === 'same') {
    return effectiveFontPrefs(fontPrefs.value, props.target).families.filter((family) => family !== systemKeyword);
  }
  return [];
}

function setMode(value: string): void {
  const next = fontModes(props.target).find((candidate) => candidate === value);
  if (next === undefined || next === mode.value) return;
  if (next === 'custom' && families.value.length === 0) {
    setFontPref(props.target, { mode: next, families: prefillFamilies(mode.value) });
  } else {
    setFontPref(props.target, { mode: next });
  }
  track('settings_changed', { key: `font-${props.target}`, value: next, source_panel: props.sourcePanel });
  draftText.value = '';
  comboOpen.value = false;
  activeIndex.value = -1;
}

function addFamily(name: string): void {
  const typed = name.trim();
  const family =
    getBundledFont(typed)?.family ??
    localFontFamilies.value.find((candidate) => candidate.toLowerCase() === typed.toLowerCase()) ??
    localFontFamilies.value.find((candidate) =>
      fontMetadata.value[candidate]?.metadata?.names.some(
        (record) => [1, 16].includes(record.id) && record.text.toLowerCase() === typed.toLowerCase(),
      ),
    ) ??
    typed;
  draftText.value = '';
  activeIndex.value = -1;
  if (family === '' || fontFamilyKind(family) === 'generic' || isSelectedFamily(family)) return;
  setFamilies([...families.value, family]);
}
function removeFamily(index: number): void {
  setFamilies(families.value.filter((_, i) => i !== index));
}
function onRemoveChip(index: number): void {
  removeFamily(index);
  void nextTick(() => tokenInputRef.value?.focus());
}
function moveFamily(index: number, delta: -1 | 1): void {
  const to = index + delta;
  const current = families.value[index];
  const neighbor = families.value[to];
  if (current === undefined || neighbor === undefined) return;
  const next = [...families.value];
  next[to] = current;
  next[index] = neighbor;
  setFamilies(next);
}

function onDraft(value: string): void {
  draftText.value = value;
  activeIndex.value = -1;
  comboOpen.value = true;
}
function onDraftFocus(): void {
  ensureLocalFonts();
  comboOpen.value = true;
}
function onDraftBlur(): void {
  comboOpen.value = false;
  activeIndex.value = -1;
}
function scrollActiveIntoView(): void {
  const el = document.getElementById(`${listboxId}-opt-${activeIndex.value}`);
  if (el instanceof HTMLElement) el.scrollIntoView({ block: 'nearest' });
}
function onDraftKeydown(event: KeyboardEvent): void {
  if (isImeKeyEvent(event)) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!comboOpen.value) {
      comboOpen.value = true;
      return;
    }
    const indexes = enabledIndexes.value;
    if (indexes.length === 0) return;
    const current = indexes.indexOf(activeIndex.value);
    const next =
      event.key === 'ArrowDown'
        ? (current + 1) % indexes.length
        : current < 0
          ? indexes.length - 1
          : (current - 1 + indexes.length) % indexes.length;
    activeIndex.value = indexes[next] ?? -1;
    visibleFamilyCount.value = Math.max(visibleFamilyCount.value, activeIndex.value + 1);
    void nextTick(scrollActiveIntoView);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    const match = familyMatches.value[activeIndex.value];
    if (match !== undefined) addFamily(match);
    else if (draftText.value.trim() !== '') addFamily(draftText.value);
  } else if (event.key === 'Escape') {
    if (comboOpen.value) {
      event.stopPropagation();
      comboOpen.value = false;
      activeIndex.value = -1;
    }
  } else if (event.key === 'Backspace' && draftText.value === '' && families.value.length > 0) {
    removeFamily(families.value.length - 1);
  }
}

const chipDrag = useWrapReorderDrag({
  ids: () => families.value,
  container: fieldRef,
  move: (family, to) => {
    const from = families.value.indexOf(family);
    if (from >= 0) setFamilies(movedOrder(families.value, from, to));
  },
});
function onChipPointerDown(event: PointerEvent, family: string): void {
  if (event.target instanceof Element && event.target.closest('button')) return;
  chipDrag.onPointerDown(event, family);
}
function onChipKeydown(event: KeyboardEvent, index: number): void {
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    moveFamily(index, -1);
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    moveFamily(index, 1);
  } else if (event.key === 'Backspace' || event.key === 'Delete') {
    event.preventDefault();
    removeFamily(index);
    tokenInputRef.value?.focus();
  }
}

function onSize(value: number | null): void {
  const previous = prefs.value.size;
  setFontPref(props.target, { size: value });
  const size = prefs.value.size;
  if (size === previous) return;
  track('settings_changed', {
    key: `font-${props.target}-size`,
    value: size === null ? 'default' : String(size),
    source_panel: props.sourcePanel,
  });
}

</script>

<template>
  <SettingsSubpage
    :parent-title="t('settings.fonts')"
    :title="t(FONT_TITLE_KEYS[target])"
    :description="t(FONT_HINT_KEYS[target])"
    fit
    @back="emit('back')"
  >
    <div class="fs-fields">
      <FontSettingsPreview :target="target" />
      <div v-if="target === 'terminal'" class="fs-field">
        <span class="fs-flabel">{{ t('settings.fontBaseSize') }}</span>
        <span class="fs-control fs-control--narrow">
          <NumberInput
            :model-value="prefs.size"
            :min="FONT_SIZE_MIN"
            :max="FONT_SIZE_MAX"
            :placeholder="13"
            :aria-label="t('settings.fontBaseSize')"
            @update:model-value="onSize"
          />
        </span>
      </div>
      <span :id="modeLabelId" class="fs-section-label">{{ t('settings.fontModeLabel') }}</span>
      <RadioCardGroup
        :model-value="mode"
        :options="modeOptions"
        :aria-labelledby="modeLabelId"
        @update:model-value="setMode"
      >
        <template #description-addon="{ option }">
          <IconButton
            v-if="option.value === 'custom'"
            class="fs-fallback-info"
            size="sm"
            :label="t('settings.fontFamilyHintFull')"
            :tooltip="t('settings.fontFamilyHintFull')"
            @click.stop
          >
            <Icon name="info" size="sm" />
          </IconButton>
        </template>
        <template #detail="{ option }">
          <div v-if="option.value === 'custom'" class="fs-custom">
            <span class="fs-hint fs-hint--inline">{{ t('settings.fontFamilyHint') }}</span>
            <div
              ref="fieldRef"
              class="fs-combo fs-tokens"
              :class="{ 'is-reordering': chipDrag.draggingId.value !== null }"
              @mousedown.self.prevent="tokenInputRef?.focus()"
            >
              <template v-for="(f, i) in families" :key="f">
                <span
                  class="fs-chip"
                  :class="{ 'is-dragging': chipDrag.draggingId.value === f }"
                  :style="chipDrag.styleFor(f)"
                  :data-reorder-id="f"
                  tabindex="0"
                  :title="displayFamily(f) === f ? f : `${displayFamily(f)} (${f})`"
                  @pointerdown="onChipPointerDown($event, f)"
                  @keydown="onChipKeydown($event, i)"
                >
                  <span class="fs-grip" aria-hidden="true"><Icon name="grip" /></span>
                  <span class="fs-ord" aria-hidden="true">{{ i + 1 }}</span>
                  <span class="nm">{{ displayFamily(f) }}</span>
                  <Badge
                    v-if="chipOrigins[i]"
                    size="sm"
                    class="fs-chip-origin"
                    :variant="chipOrigins[i]?.variant"
                  >
                    {{ t(chipOrigins[i]?.key ?? '') }}
                  </Badge>
                  <IconButton
                    size="sm"
                    class="fs-chip-x"
                    :label="t('settings.fontRemoveFamily', { font: displayFamily(f) })"
                    :tooltip="t('settings.fontRemoveFamilyTooltip')"
                    @mousedown.prevent
                    @click="onRemoveChip(i)"
                  >
                    <Icon name="close" size="sm" />
                  </IconButton>
                </span>
              </template>
              <input
                ref="tokenInputRef"
                class="fs-token-input"
                :value="draftText"
                :placeholder="families.length === 0 ? t('settings.fontFamilyEmpty') : undefined"
                :aria-label="t('settings.fontFamily')"
                role="combobox"
                :aria-expanded="comboOpen"
                :aria-controls="listboxId"
                :aria-activedescendant="activeIndex >= 0 ? `${listboxId}-opt-${activeIndex}` : undefined"
                aria-autocomplete="list"
                @input="onDraft(($event.target as HTMLInputElement).value)"
                @focus="onDraftFocus"
                @blur="onDraftBlur"
                @keydown="onDraftKeydown"
              />
              <Teleport to="body">
                <Menu
                  v-if="menuVisible"
                  ref="menuRef"
                  :id="listboxId"
                  role="listbox"
                  class="fs-menu"
                  :style="menuStyle"
                  :aria-busy="fontsLoading"
                  @scroll="onMenuScroll"
                >
                  <template v-for="(f, i) in visibleFamilyMatches" :key="f">
                    <div v-if="i === 0 && bundledMatches.length > 0" class="fs-menu-label" role="presentation">
                      {{ t('settings.fontsKimiCode') }}
                    </div>
                    <template v-if="i === bundledMatches.length">
                      <div v-if="i > 0" class="fs-menu-separator" role="separator" />
                      <div class="fs-menu-label" role="presentation">{{ t('settings.fontsSystem') }}</div>
                    </template>
                    <MenuItem
                      :id="`${listboxId}-opt-${i}`"
                      role="option"
                      :active="i === activeIndex && !isSelectedFamily(f)"
                      :aria-selected="isSelectedFamily(f)"
                      :aria-disabled="isSelectedFamily(f) || undefined"
                      @mousedown.prevent
                      @click="isSelectedFamily(f) ? undefined : addFamily(f)"
                      @mouseenter="isSelectedFamily(f) ? undefined : (activeIndex = i)"
                    >
                      <FontOptionPreview
                        :family="f"
                        :label="fontFamilyKind(f) === 'font' ? undefined : displayFamily(f)"
                      />
                      <Icon v-if="isSelectedFamily(f)" name="check" size="sm" />
                    </MenuItem>
                  </template>
                  <template v-if="systemMatches.length === 0 && fontsLoading">
                    <div v-if="bundledMatches.length > 0" class="fs-menu-separator" role="separator" />
                    <div class="fs-menu-label" role="presentation">{{ t('settings.fontsSystem') }}</div>
                  </template>
                  <div v-if="fontsLoading" class="fs-loading" role="status">
                    <Spinner size="sm" />
                    <span>{{ t('settings.fontsLoading') }}</span>
                  </div>
                  <template v-if="addCandidate !== null">
                    <div v-if="familyMatches.length > 0" class="fs-menu-separator" role="separator" />
                    <MenuItem
                      :id="`${listboxId}-opt-${addIndex}`"
                      role="option"
                      class="fs-menu-add"
                      :active="activeIndex === addIndex"
                      :aria-selected="false"
                      @mousedown.prevent
                      @click="addFamily(addCandidate)"
                      @mouseenter="activeIndex = addIndex"
                    >
                      <Icon name="plus" size="sm" />
                      <span class="fs-menu-add-label">{{ t('settings.fontAddFamily', { font: addCandidate }) }}</span>
                    </MenuItem>
                  </template>
                  <p v-if="showUnavailableNote" class="fs-menu-note" role="note">{{ t('settings.fontsUnavailableNote') }}</p>
                </Menu>
              </Teleport>
            </div>
          </div>
        </template>
      </RadioCardGroup>
    </div>
  </SettingsSubpage>
</template>

<style scoped>
.fs-fields {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.fs-field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: 32px;
}
.fs-flabel {
  display: flex;
  flex-direction: column;
  font-size: var(--text-sm);
  color: var(--color-text);
}
.fs-hint {
  font-size: var(--text-xs);
  line-height: var(--leading-tight);
  color: var(--color-text-faint);
}
.fs-hint--inline {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fs-section-label {
  margin-top: var(--space-3);
  font-size: var(--text-xs);
  line-height: var(--leading-tight);
  color: var(--color-text-muted);
}
.fs-custom {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
  padding-top: var(--space-1);
}
.fs-control { display: flex; flex-direction: column; width: 240px; max-width: 50vw; flex: none; }
.fs-control--narrow { width: 110px; }

.fs-combo { position: relative; }
.fs-tokens {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1);
  min-height: var(--space-8);
  padding: var(--space-1);
  background: var(--color-surface-overlay);
  border: 0.5px solid var(--color-line-strong);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
  cursor: text;
}
.fs-tokens:focus-within {
  border-color: var(--color-accent);
  box-shadow: var(--p-focus-ring);
}
.fs-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  box-sizing: border-box;
  max-width: 100%;
  height: var(--space-6);
  padding: 0 var(--space-05) 0 var(--space-1);
  background: var(--color-surface-raised);
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-xs);
  font-size: var(--text-sm);
  color: var(--color-text);
  cursor: grab;
  touch-action: none;
  user-select: none;
}
.fs-chip:active { cursor: grabbing; }
.fs-chip:focus-visible {
  outline: none;
  box-shadow: 0 0 0 1px var(--color-line-strong), 0 0 0 4px var(--color-line);
}
.fs-tokens.is-reordering { cursor: grabbing; }
.fs-tokens.is-reordering .fs-chip {
  transition: transform var(--duration-fast) var(--ease-in-out);
}
.fs-tokens.is-reordering .fs-chip.is-dragging {
  position: relative;
  z-index: 1;
  transition: none;
  box-shadow: var(--shadow-md);
  cursor: grabbing;
}
@media (prefers-reduced-motion: reduce) {
  .fs-tokens.is-reordering .fs-chip { transition: none; }
}
.fs-grip {
  display: inline-flex;
  flex: none;
  color: var(--color-text-faint);
}
.fs-ord {
  flex: none;
  font-size: var(--text-xs);
  color: var(--color-text-faint);
}
.fs-chip-origin { flex: none; }
.fs-chip .nm {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fs-chip .fs-chip-x {
  width: var(--icon-button-xs);
  height: var(--icon-button-xs);
  border-radius: var(--radius-full);
  color: var(--color-text-faint);
}
.fs-chip .fs-chip-x:hover { color: var(--color-danger); }
.fs-menu-label {
  flex: none;
  padding: var(--space-1) var(--space-2) var(--space-05);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  user-select: none;
}
.fs-loading {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}
.fs-menu-add-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fs-menu-note {
  flex: none;
  margin: 0;
  padding: var(--space-2) var(--space-2) var(--space-1);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
}
.fs-menu-separator {
  flex: none;
  height: var(--p-hairline);
  margin: var(--space-1) var(--space-2);
  background: var(--color-line-strong);
}
.fs-token-input {
  flex: 1;
  min-width: 90px;
  height: var(--space-6);
  padding: 0 var(--space-1);
  border: none;
  background: transparent;
  outline: none;
  font-family: inherit;
  font-size: var(--text-sm);
  color: var(--color-text);
}
.fs-token-input::placeholder { color: var(--color-text-faint); }

.fs-menu {
  position: fixed;
  z-index: var(--z-modal-dropdown);
  max-height: 240px;
  overflow-y: auto;
}
.fs-menu::-webkit-scrollbar-track { margin-block: var(--radius-lg); }
</style>
