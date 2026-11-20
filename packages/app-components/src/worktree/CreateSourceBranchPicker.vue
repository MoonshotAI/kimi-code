<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { newSessionEnvironmentStore } from '@moonshot-ai/app-client/stores';
import { Icon, MenuItem, Switch, menuNavigationIndex, useImeComposition } from '@moonshot-ai/app-ui';
import CreateSetupScriptDialog from './CreateSetupScriptDialog.vue';
import { useCreatePopover } from './createPopover';

const props = defineProps<{
  workspaceId?: string | null;
  workspaceName?: string;
}>();

interface BranchRow {
  key: string;
  branch: string;
  includeLocalChanges: boolean;
  selected: boolean;
  remote?: string;
}

const HOVER_DELAY_MS = 150;
const PANEL_WIDTH_PX = 320;
const VIEWPORT_MARGIN_PX = 16;

const { t } = useI18n();
const store = newSessionEnvironmentStore();

const view = computed(() => store.view(props.workspaceId));
const selection = computed(() => view.value.selection);
const visible = computed(() => view.value.effective === 'worktree' && selection.value !== null);
const branchName = computed(() => selection.value?.branch.name ?? '');
const includesLocalChanges = computed(() => selection.value?.includeLocalChanges === true);
const glyphIcon = computed(() => (view.value.usesRemote ? 'git-branch-cloud' : 'worktree-branch'));
const hoverRef = computed(() =>
  view.value.usesRemote ? (selection.value?.branch.remoteRef ?? branchName.value) : branchName.value,
);

const anchorRef = ref<HTMLElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);
const triggerRef = ref<HTMLButtonElement | null>(null);
const searchRef = ref<HTMLInputElement | null>(null);
const listRef = ref<HTMLElement | null>(null);
const { open, up, maxHeight, toggle, close } = useCreatePopover(anchorRef, panelRef, triggerRef);

const query = ref('');
const activeIndex = ref(-1);
const alignRight = ref(false);
const fadeTop = ref(false);
const fadeBottom = ref(false);

function matches(name: string): boolean {
  const needle = query.value.trim().toLowerCase();
  return needle.length === 0 || name.toLowerCase().includes(needle);
}

const localRow = computed<BranchRow | null>(() => {
  const head = view.value.headBranch;
  if (!view.value.canIncludeLocalChanges || head === undefined || !matches(head)) return null;
  return {
    key: `local:${head}`,
    branch: head,
    includeLocalChanges: true,
    selected: includesLocalChanges.value && branchName.value === head,
  };
});

const showRemoteNames = computed(() => view.value.remotes.length >= 2);

const branchRows = computed<BranchRow[]>(() =>
  view.value.branches
    .filter((branch) => matches(branch.name))
    .map((branch) => ({
      key: `branch:${branch.name}`,
      branch: branch.name,
      includeLocalChanges: false,
      selected: !includesLocalChanges.value && branchName.value === branch.name,
      remote: showRemoteNames.value ? branch.remote : undefined,
    })),
);

const rows = computed<BranchRow[]>(() => (localRow.value === null ? branchRows.value : [localRow.value, ...branchRows.value]));

function updateFades(): void {
  const el = listRef.value;
  if (el === null) {
    fadeTop.value = false;
    fadeBottom.value = false;
    return;
  }
  fadeTop.value = el.scrollTop > 1;
  fadeBottom.value = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
}

function revealActive(): void {
  const row = listRef.value?.querySelector<HTMLElement>('.wsb-row.active');
  row?.scrollIntoView?.({ block: 'nearest' });
}

watch(open, async (isOpen) => {
  if (!isOpen) {
    query.value = '';
    return;
  }
  hideHover();
  void store.refreshBranches(props.workspaceId);
  void store.ensureSetupScript(props.workspaceId);
  const rect = anchorRef.value?.getBoundingClientRect();
  alignRight.value =
    rect !== undefined && rect.left + PANEL_WIDTH_PX > window.innerWidth - VIEWPORT_MARGIN_PX && rect.right >= PANEL_WIDTH_PX;
  activeIndex.value = rows.value.findIndex((row) => row.selected);
  await nextTick();
  searchRef.value?.focus({ preventScroll: true });
  revealActive();
  updateFades();
});

watch(query, () => {
  activeIndex.value = rows.value.length > 0 ? 0 : -1;
});

watch(rows, () => {
  if (activeIndex.value >= rows.value.length) activeIndex.value = rows.value.length - 1;
  void nextTick(updateFades);
});

function selectRow(row: BranchRow): void {
  if (props.workspaceId === undefined || props.workspaceId === null) return;
  store.selectSource(props.workspaceId, { branch: row.branch, includeLocalChanges: row.includeLocalChanges });
}

const { handleCompositionStart, handleCompositionEnd, isComposingKeyEvent } = useImeComposition();

function onSearchKeydown(event: KeyboardEvent): void {
  if (isComposingKeyEvent(event)) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    const row = rows.value[activeIndex.value];
    if (row !== undefined) selectRow(row);
    return;
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const next = menuNavigationIndex(event.key, false, activeIndex.value, rows.value.length);
  if (next === null) return;
  event.preventDefault();
  activeIndex.value = next;
  void nextTick(revealActive);
}

function setUseRemote(value: boolean): void {
  if (props.workspaceId === undefined || props.workspaceId === null) return;
  store.setUseRemote(props.workspaceId, value);
}

const scriptExists = computed(() => view.value.setupScript?.exists === true);
const scriptDialogOpen = ref(false);

function openScriptDialog(): void {
  close();
  scriptDialogOpen.value = true;
}

const hoverOpen = ref(false);
let hoverTimer: ReturnType<typeof setTimeout> | null = null;

function showHover(): void {
  if (open.value || hoverTimer !== null) return;
  hoverTimer = setTimeout(() => {
    hoverTimer = null;
    if (!open.value) hoverOpen.value = true;
  }, HOVER_DELAY_MS);
}

function hideHover(): void {
  if (hoverTimer !== null) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }
  hoverOpen.value = false;
}

onUnmounted(hideHover);
</script>

<template>
  <div v-if="visible" ref="anchorRef" class="wsb" data-worktree-source-branch>
    <button
      ref="triggerRef"
      type="button"
      class="wsb-chip"
      :class="{ open }"
      aria-haspopup="dialog"
      :aria-expanded="open"
      :aria-label="`${t('worktreeCreate.branch.label')}: ${branchName}`"
      @click.stop="toggle"
      @mouseenter="showHover"
      @mouseleave="hideHover"
      @focus="showHover"
      @blur="hideHover"
    >
      <span class="wsb-glyph" :class="{ 'has-dot': includesLocalChanges }" :data-glyph="glyphIcon">
        <Icon :name="glyphIcon" size="md" />
      </span>
      <span class="wsb-chip-name">{{ branchName }}</span>
      <Icon class="wsb-chip-chev" name="chevron-down" size="sm" />
    </button>
    <div v-if="hoverOpen && !open" class="wsb-hover" role="tooltip">
      <div class="wsb-hover-row wsb-hover-main">
        <Icon :name="glyphIcon" size="sm" />
        <span>{{ hoverRef }}</span>
      </div>
      <div v-if="includesLocalChanges" class="wsb-hover-row">
        <span class="wsb-glyph has-dot"><Icon name="worktree-branch" size="sm" /></span>
        <span>{{ t('worktreeCreate.branch.includeLocalChanges') }}</span>
      </div>
    </div>
    <div
      v-if="open"
      ref="panelRef"
      class="wsb-panel"
      :class="{ up, 'align-right': alignRight }"
      :style="maxHeight === null ? undefined : { maxHeight: `${maxHeight}px` }"
      role="dialog"
      :aria-label="t('worktreeCreate.branch.label')"
    >
      <div class="wsb-search">
        <Icon name="search" size="sm" />
        <input
          ref="searchRef"
          v-model="query"
          class="wsb-search-input"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          :placeholder="t('worktreeCreate.branch.searchPlaceholder')"
          :aria-label="t('worktreeCreate.branch.searchPlaceholder')"
          autocomplete="off"
          spellcheck="false"
          @keydown="onSearchKeydown"
          @compositionstart="handleCompositionStart"
          @compositionend="handleCompositionEnd"
        />
      </div>
      <div
        ref="listRef"
        class="wsb-list"
        :class="{ 'fade-top': fadeTop, 'fade-bottom': fadeBottom }"
        role="listbox"
        @scroll.passive="updateFades"
      >
        <div v-if="rows.length === 0" class="wsb-empty">{{ t('worktreeCreate.branch.empty') }}</div>
        <template v-if="localRow">
          <div class="wsb-group">{{ t('worktreeCreate.branch.localFileStatus') }}</div>
          <button
            type="button"
            class="wsb-row"
            :class="{ on: localRow.selected, active: activeIndex === 0 }"
            role="option"
            tabindex="-1"
            :aria-selected="localRow.selected"
            data-row="local"
            @mousemove="activeIndex = 0"
            @click.stop="selectRow(localRow)"
          >
            <span class="wsb-glyph has-dot"><Icon name="worktree-branch" size="md" /></span>
            <span class="wsb-row-text">
              <span class="wsb-row-name">{{ localRow.branch }}</span>
              <span class="wsb-row-desc">{{ t('worktreeCreate.branch.includeLocalChangesHint') }}</span>
            </span>
            <Icon v-if="localRow.selected" class="wsb-row-check" name="check" size="sm" />
          </button>
        </template>
        <template v-if="branchRows.length > 0">
          <div class="wsb-group">{{ t('worktreeCreate.branch.localBranches') }}</div>
          <button
            v-for="(row, index) in branchRows"
            :key="row.key"
            type="button"
            class="wsb-row"
            :class="{ on: row.selected, active: activeIndex === index + (localRow ? 1 : 0) }"
            role="option"
            tabindex="-1"
            :aria-selected="row.selected"
            :data-row="row.branch"
            @mousemove="activeIndex = index + (localRow ? 1 : 0)"
            @click.stop="selectRow(row)"
          >
            <span class="wsb-glyph"><Icon name="worktree-branch" size="md" /></span>
            <span class="wsb-row-text">
              <span class="wsb-row-name">{{ row.branch }}</span>
            </span>
            <span v-if="row.remote" class="wsb-row-remote" data-remote>{{ row.remote }}</span>
            <Icon v-if="row.selected" class="wsb-row-check" name="check" size="sm" />
          </button>
        </template>
      </div>
      <MenuItem class="wsb-sep" separator />
      <div class="wsb-foot">
        <div v-if="view.remoteAvailable" class="wsb-foot-row" data-foot="remote">
          <Icon class="wsb-foot-icon" name="git-branch-cloud" size="md" />
          <span class="wsb-foot-label">{{ t('worktreeCreate.branch.useRemote') }}</span>
          <Switch
            :model-value="view.useRemote"
            :label="t('worktreeCreate.branch.useRemote')"
            @update:model-value="setUseRemote"
          />
        </div>
        <div v-else class="wsb-foot-row is-note" data-foot="no-remote">
          <Icon class="wsb-foot-icon" name="worktree-branch" size="md" />
          <span class="wsb-foot-label">{{ t('worktreeCreate.branch.noRemote') }}</span>
        </div>
        <div class="wsb-foot-row" data-foot="script">
          <Icon class="wsb-foot-icon" name="terminal" size="md" />
          <span class="wsb-foot-label wsb-foot-script">
            <span>{{ t('worktreeCreate.script.label') }}</span>
            <button type="button" class="wsb-link" data-action="script" @click.stop="openScriptDialog">
              {{ t(scriptExists ? 'worktreeCreate.script.edit' : 'worktreeCreate.script.configure') }}
            </button>
          </span>
          <Switch
            v-if="scriptExists"
            :model-value="view.runSetupScript"
            :label="t('worktreeCreate.script.runForSession')"
            @update:model-value="store.setRunSetupScript($event)"
          />
        </div>
      </div>
    </div>
    <CreateSetupScriptDialog
      v-model:open="scriptDialogOpen"
      :workspace-id="workspaceId"
      :workspace-name="workspaceName"
    />
  </div>
</template>

<style scoped>
.wsb {
  position: relative;
  display: flex;
  flex: 0 1 auto;
  min-width: 88px;
  font-family: var(--font-ui);
}
.wsb-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  min-width: 0;
  height: 28px;
  margin-bottom: 4px;
  padding: 0 var(--space-2);
  border: none;
  border-radius: 10px;
  background: var(--color-selected);
  -webkit-backdrop-filter: blur(30px);
  backdrop-filter: blur(30px);
  color: var(--color-text);
  font-family: inherit;
  font-size: var(--ui-font-size-sm);
  cursor: pointer;
  transition: color var(--duration-base) var(--ease-out);
}
.wsb-chip:hover,
.wsb-chip.open {
  color: var(--color-text-strong);
}
.wsb-chip:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.wsb-chip-name {
  min-width: 0;
  overflow: hidden;
  font-weight: var(--weight-option-label);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wsb-chip-chev {
  flex: none;
  transition: transform var(--duration-base) var(--ease-out);
}
.wsb-chip.open .wsb-chip-chev {
  transform: rotate(180deg);
}
.wsb-glyph {
  position: relative;
  display: inline-flex;
  flex: none;
  line-height: 0;
}
.wsb-glyph.has-dot::after {
  content: '';
  position: absolute;
  top: -2px;
  right: -3px;
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  background: var(--color-accent);
}
.wsb-hover {
  position: absolute;
  bottom: calc(100% + var(--space-1));
  left: 0;
  z-index: var(--z-tooltip);
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: max-content;
  max-width: min(320px, calc(100vw - var(--space-8)));
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--color-text);
  color: var(--color-bg);
  font-size: var(--text-xs);
  line-height: 1.35;
  pointer-events: none;
}
.wsb-hover-row {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  min-width: 0;
  opacity: 0.8;
}
.wsb-hover-row > span:last-child {
  min-width: 0;
  overflow-wrap: anywhere;
}
.wsb-hover-main {
  font-weight: var(--weight-semibold);
  opacity: 1;
}
.wsb-panel {
  position: absolute;
  top: calc(100% + var(--space-1));
  left: 0;
  z-index: var(--z-dropdown);
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  width: min(320px, calc(100vw - var(--space-8)));
  overflow: hidden;
  padding: var(--space-1);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-lg);
  background: var(--color-menu-bg);
  -webkit-backdrop-filter: var(--p-menu-backdrop);
  backdrop-filter: var(--p-menu-backdrop);
  box-shadow: var(--shadow-sm);
  animation: wsb-pop var(--duration-base) var(--ease-out);
}
.wsb-panel.align-right {
  right: 0;
  left: auto;
}
.wsb-panel.up {
  top: auto;
  bottom: calc(100% + var(--space-1));
}
@keyframes wsb-pop {
  from {
    opacity: 0;
    transform: scale(0.99);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
.wsb-search {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-2);
  margin: 0 var(--space-1);
  padding: var(--space-2) var(--space-1);
  border-bottom: var(--p-hairline) solid var(--color-line);
  color: var(--color-text-faint);
}
.wsb-search:focus-within {
  border-bottom-color: var(--color-line-strong);
}
.wsb-search-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
}
.wsb-search-input::placeholder {
  color: var(--color-text-faint);
}
.wsb-list {
  --wsb-row-h: 30px;
  flex: 0 1 auto;
  min-height: 0;
  max-height: calc(var(--wsb-row-h) * 9.5);
  overflow-y: auto;
  overscroll-behavior: contain;
}
.wsb-list.fade-top {
  mask-image: linear-gradient(to bottom, transparent, black var(--menu-scroll-fade));
}
.wsb-list.fade-bottom {
  mask-image: linear-gradient(to top, transparent, black var(--menu-scroll-fade));
}
.wsb-list.fade-top.fade-bottom {
  mask-image: linear-gradient(
    to bottom,
    transparent,
    black var(--menu-scroll-fade),
    black calc(100% - var(--menu-scroll-fade)),
    transparent
  );
}
.wsb-empty {
  padding: var(--space-3) var(--space-2);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  text-align: center;
  user-select: none;
}
.wsb-group {
  padding: var(--space-2) var(--space-2) var(--space-1);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  font-weight: var(--weight-section-label);
  user-select: none;
}
.wsb-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: var(--wsb-row-h);
  padding: var(--space-1) var(--space-2);
  border: none;
  border-radius: var(--radius-dropdown-row);
  background: none;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
.wsb-row.active {
  background: var(--color-hover);
}
.wsb-row.on {
  background: var(--color-selected);
}
.wsb-row .wsb-glyph {
  color: var(--color-text-muted);
}
.wsb-row-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}
.wsb-row-name {
  overflow: hidden;
  color: var(--color-text);
  font-size: var(--text-base);
  font-weight: var(--weight-option-label);
  line-height: var(--leading-normal);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wsb-row-desc {
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  overflow-wrap: anywhere;
}
.wsb-row-remote {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 40%;
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wsb-row-check {
  flex: none;
  margin-left: var(--space-2);
  color: var(--color-text);
}
.wsb-sep {
  flex: none;
}
.wsb-foot {
  display: flex;
  flex: none;
  flex-direction: column;
  padding-bottom: 2px;
}
.wsb-foot-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 28px;
  padding: 2px var(--space-2);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}
.wsb-foot-icon {
  flex: none;
}
.wsb-foot-label {
  flex: 1;
  min-width: 0;
  line-height: var(--leading-normal);
}
.wsb-foot-script {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.wsb-link {
  padding: 0;
  border: none;
  border-radius: var(--radius-xs);
  background: none;
  color: var(--color-accent);
  font: inherit;
  cursor: pointer;
}
.wsb-link:hover {
  text-decoration: underline;
}
.wsb-link:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
</style>
