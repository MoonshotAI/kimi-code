<!-- apps/web/src/components/admin/MultiSelectMenu.vue -->
<!-- Workspace multi-select for the session admin filter bar: an antd-style
     tag trigger (selected workspaces as removable tags — at most two shown,
     then +N) over an anchored panel whose first row is a search box filtering
     the options (case-insensitive substring). Option rows carry no checkbox —
     selected ones just take the active highlight. Empty selection = no filter
     (trigger falls back to the 全部工作空间 placeholder). The panel STAYS OPEN
     on toggles so several workspaces can be picked in one go — Esc / outside
     click / scroll closes. -->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon, Menu, MenuItem } from '@moonshot-ai/app-ui';
import { useAnchoredMenu } from './useAnchoredMenu';

const props = defineProps<{
  /** Selectable workspaces, in display order (the tags keep this order). */
  options: Array<{ id: string; name: string }>;
  /** Selected workspace ids; empty = no filter. */
  modelValue: string[];
  ariaLabel?: string;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>();

const { t } = useI18n();
const menuRef = ref<InstanceType<typeof Menu> | null>(null);
const { open, menuStyle, toggle } = useAnchoredMenu(menuRef);

// The filter bar's Enter-to-query guard reads whether any overlay is open.
defineExpose({ open });

const selected = computed(() => new Set(props.modelValue));
const allSelected = computed(
  () => props.options.length > 0 && selected.value.size === props.options.length,
);

// Trigger tags: the selected workspaces in OPTIONS order (deterministic),
// at most two rendered, the rest collapse into "+N".
const selectedTags = computed(() => props.options.filter((o) => selected.value.has(o.id)));
const visibleTags = computed(() => selectedTags.value.slice(0, 2));
const overflowCount = computed(() => selectedTags.value.length - visibleTags.value.length);

// Search (the menu's first row): case-insensitive name substring, reset on
// close; autofocused on open.
const query = ref('');
const searchRef = ref<HTMLInputElement | null>(null);
const filteredOptions = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (q === '') return props.options;
  return props.options.filter((o) => o.name.toLowerCase().includes(q));
});
watch(open, (isOpen) => {
  if (isOpen) void nextTick(() => searchRef.value?.focus());
  else query.value = '';
});

/** Emit the new selection in fixed OPTIONS order (not click order) so the
 *  tags and the wire `workspaceIds` are deterministic. */
function emitSelection(next: Set<string>): void {
  emit(
    'update:modelValue',
    props.options.filter((o) => next.has(o.id)).map((o) => o.id),
  );
}

function toggleOption(id: string): void {
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  emitSelection(next);
}

function removeTag(id: string): void {
  const next = new Set(selected.value);
  next.delete(id);
  emitSelection(next);
}

function toggleAll(): void {
  emitSelection(allSelected.value ? new Set() : new Set(props.options.map((o) => o.id)));
}

/** The trigger is a div (it nests the tags' × buttons, so it can't be a real
 *  button); useAnchoredMenu.toggle only reads currentTarget, so a keyboard
 *  event anchors exactly like a click. */
function toggleViaKeyboard(e: KeyboardEvent): void {
  toggle(e as unknown as MouseEvent);
}
</script>

<template>
  <div
    class="sa-select"
    :class="{ 'is-open': open }"
    role="button"
    tabindex="0"
    :aria-label="ariaLabel"
    @click="toggle"
    @keydown.enter.prevent="toggleViaKeyboard"
    @keydown.space.prevent="toggleViaKeyboard"
  >
    <template v-if="selectedTags.length > 0">
      <span v-for="tag in visibleTags" :key="tag.id" class="sa-tag">
        <span class="sa-tag-name">{{ tag.name }}</span>
        <button
          class="sa-tag-x"
          type="button"
          :aria-label="t('admin.removeTag', { name: tag.name })"
          @click.stop="removeTag(tag.id)"
          @keydown.enter.stop
          @keydown.space.stop
        >
          <Icon name="close" size="sm" />
        </button>
      </span>
      <span v-if="overflowCount > 0" class="sa-tag-more">+{{ overflowCount }}</span>
    </template>
    <span v-else class="sa-select-label">{{ t('admin.allWorkspaces') }}</span>
    <Icon class="sa-select-chev" name="chevron-down" size="sm" />
  </div>
  <Transition name="menu-pop">
    <!-- role=dialog: the panel leads with a search input, so it isn't a pure
         menu (Menu's own contract); its rows take role=button to match. -->
    <Menu v-if="open" ref="menuRef" class="sa-menu" :style="menuStyle" role="dialog" @click.stop>
      <div class="sa-search">
        <Icon name="search" size="sm" />
        <input
          ref="searchRef"
          v-model="query"
          class="sa-search-input"
          type="text"
          :placeholder="t('admin.searchWorkspace')"
          :aria-label="t('admin.searchWorkspace')"
        />
      </div>
      <MenuItem role="button" :active="allSelected" @click="toggleAll">
        {{ t('admin.selectAll') }}
      </MenuItem>
      <MenuItem separator />
      <div class="sa-opts">
        <MenuItem
          v-for="opt in filteredOptions"
          :key="opt.id"
          role="button"
          :active="selected.has(opt.id)"
          @click="toggleOption(opt.id)"
        >
          <span class="sa-ws-name">{{ opt.name }}</span>
        </MenuItem>
        <div v-if="filteredOptions.length === 0" class="sa-menu-empty">
          {{ t('admin.noWorkspaceMatch') }}
        </div>
      </div>
    </Menu>
  </Transition>
</template>

<style scoped>
.sa-select {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  min-height: 30px;
  padding: 0 var(--space-2);
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text);
  font-size: var(--text-sm);
  font-weight: var(--weight-option-label);
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out);
}
.sa-select:hover,
.sa-select.is-open {
  background: var(--color-hover);
}
.sa-select:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.sa-select-chev {
  color: var(--color-text-faint);
}

/* Trigger tag: selected workspace chip — neutral selected wash, name
   ellipsized, × removes without opening the panel. */
.sa-tag {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  height: 20px;
  padding: 0 2px 0 var(--space-1-5);
  border-radius: var(--radius-xs);
  background: var(--color-selected);
  font-size: var(--text-xs);
}
.sa-tag-name {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sa-tag-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--color-text-faint);
  cursor: pointer;
  transition:
    background var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}
.sa-tag-x:hover {
  background: var(--color-hover);
  color: var(--color-text);
}
.sa-tag-more {
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}

.sa-menu {
  position: fixed;
  top: 0;
  left: 0;
  z-index: var(--z-dropdown);
}

/* Search row: aligned with the MenuItem padding/gap so the input text sits
   exactly on the option-label grid. */
.sa-search {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 9px;
  color: var(--color-text-faint);
}
.sa-search-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  line-height: var(--leading-tight);
}
.sa-search-input::placeholder {
  color: var(--color-text-faint);
}

.sa-ws-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Options area: capped height, own scroll (useAnchoredMenu ignores scrolls
   from inside .sa-menu, so scrolling here never closes the panel). Search +
   全选 stay fixed above it. */
.sa-opts {
  max-height: 320px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.sa-menu-empty {
  padding: 5px 9px;
  color: var(--color-text-faint);
  font-size: var(--text-sm);
}

/* Menu enter/exit — pops out of the trigger corner (Sidebar menu language). */
.menu-pop-enter-active {
  transition:
    opacity var(--duration-base) var(--ease-out),
    transform var(--duration-base) var(--ease-out);
}
.menu-pop-leave-active {
  transition:
    opacity var(--duration-fast) var(--ease-out),
    transform var(--duration-fast) var(--ease-out);
  pointer-events: none;
}
.menu-pop-enter-from,
.menu-pop-leave-to {
  opacity: 0;
  transform: scale(0.97) translateY(var(--menu-pop-shift, -2px));
}
</style>
