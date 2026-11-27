<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useNewSessionEnvironment } from '@moonshot-ai/app-client/composables';
import { Icon, MenuItem, MenuSearch, StatusDot, Switch, menuNavigationIndex, useImeComposition } from '@moonshot-ai/app-ui';
import CreatePicker from './CreatePicker.vue';

const props = defineProps<{
  workspaceId?: string | null;
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

const { t } = useI18n();
const store = useNewSessionEnvironment();

const view = computed(() => store.view(props.workspaceId));
const selection = computed(() => view.value.selection);
const visible = computed(() => view.value.effective === 'worktree' && selection.value !== null);
const branchName = computed(() => selection.value?.branch.name ?? '');
const includesLocalChanges = computed(() => selection.value?.includeLocalChanges === true);
const glyphIcon = computed(() => (view.value.usesRemote ? 'git-branch-cloud' : 'worktree-branch'));
const hoverRef = computed(() =>
  view.value.usesRemote ? (selection.value?.branch.remoteRef ?? branchName.value) : branchName.value,
);

const open = ref(false);
const searchRef = ref<InstanceType<typeof MenuSearch> | null>(null);
const listRef = ref<HTMLElement | null>(null);

const query = ref('');
const activeIndex = ref(-1);
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

interface BranchGroup {
  key: string;
  label: string;
  rows: { row: BranchRow; index: number }[];
}

const groups = computed<BranchGroup[]>(() => {
  const result: BranchGroup[] = [];
  rows.value.forEach((row, index) => {
    const key = row.includeLocalChanges ? 'local' : 'branches';
    const last = result.at(-1);
    if (last?.key === key) last.rows.push({ row, index });
    else
      result.push({
        key,
        label: row.includeLocalChanges ? 'worktreeCreate.branch.localFileStatus' : 'worktreeCreate.branch.localBranches',
        rows: [{ row, index }],
      });
  });
  return result;
});

const baseId = useId();
const listId = `${baseId}-list`;

function rowId(index: number): string {
  return `${baseId}-option-${index}`;
}

const activeDescendant = computed(() => (activeIndex.value >= 0 && activeIndex.value < rows.value.length ? rowId(activeIndex.value) : undefined));

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
  const row = listRef.value?.querySelector<HTMLElement>('.wsb-row.is-active');
  row?.scrollIntoView?.({ block: 'nearest' });
}

watch(open, async (isOpen) => {
  if (!isOpen) {
    query.value = '';
    return;
  }
  hideHover();
  void store.refreshBranches(props.workspaceId);
  activeIndex.value = rows.value.findIndex((row) => row.selected);
  await nextTick();
  searchRef.value?.focus();
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

const { isComposingKeyEvent } = useImeComposition();

function onSearchKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || isComposingKeyEvent(event)) return;
  event.preventDefault();
  const row = rows.value[activeIndex.value];
  if (row !== undefined) selectRow(row);
}

function onSearchNavigate(key: 'ArrowDown' | 'ArrowUp'): void {
  const next = menuNavigationIndex(key, false, activeIndex.value, rows.value.length);
  if (next === null) return;
  activeIndex.value = next;
  void nextTick(revealActive);
}

function onPanelKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
  event.preventDefault();
  onSearchNavigate(event.key);
  searchRef.value?.focus();
}

function setUseRemote(value: boolean): void {
  if (props.workspaceId === undefined || props.workspaceId === null) return;
  store.setUseRemote(props.workspaceId, value);
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
  <CreatePicker
    v-if="visible"
    v-model:open="open"
    class="wsb"
    data-worktree-source-branch
    popup="dialog"
    chip-class="wsb-chip"
    panel-class="wsb-panel"
    :panel-width="PANEL_WIDTH_PX"
    :label="`${t('worktreeCreate.branch.label')}: ${branchName}`"
    :panel-label="t('worktreeCreate.branch.label')"
    @mouseenter="showHover"
    @mouseleave="hideHover"
    @focusin="showHover"
    @focusout="hideHover"
    @panel-keydown="onPanelKeydown"
  >
    <template #chip>
      <span class="wsb-glyph" :data-glyph="glyphIcon">
        <Icon :name="glyphIcon" size="md" />
        <StatusDot v-if="includesLocalChanges" class="wsb-dot" status="unread" size="sm" />
      </span>
      <span class="wsb-chip-name">{{ branchName }}</span>
    </template>
    <template #extra>
      <div v-if="hoverOpen && !open" class="wsb-hover ui-tip-surface" role="tooltip">
        <div class="wsb-hover-row wsb-hover-main">
          <Icon :name="glyphIcon" size="sm" />
          <span>{{ hoverRef }}</span>
        </div>
        <div v-if="includesLocalChanges" class="wsb-hover-row">
          <span class="wsb-glyph">
            <Icon name="worktree-branch" size="sm" />
            <StatusDot class="wsb-dot" status="unread" size="sm" />
          </span>
          <span>{{ t('worktreeCreate.branch.includeLocalChanges') }}</span>
        </div>
      </div>
    </template>
    <MenuSearch
      ref="searchRef"
      v-model="query"
      class="wsb-search"
      divider
      :placeholder="t('worktreeCreate.branch.searchPlaceholder')"
      :active-descendant="activeDescendant"
      :controls="listId"
      @keydown="onSearchKeydown"
      @navigate="onSearchNavigate"
    />
    <div
      :id="listId"
      ref="listRef"
      class="wsb-list"
      :class="{ 'fade-top': fadeTop, 'fade-bottom': fadeBottom }"
      role="listbox"
      :aria-label="t('worktreeCreate.branch.label')"
      @scroll.passive="updateFades"
    >
      <div v-if="rows.length === 0" class="wsb-empty">{{ t('worktreeCreate.branch.empty') }}</div>
      <div v-for="group in groups" :key="group.key" role="group" :aria-labelledby="`${baseId}-${group.key}`">
        <div :id="`${baseId}-${group.key}`" class="wsb-group">{{ t(group.label) }}</div>
        <MenuItem
          v-for="{ row, index } in group.rows"
          :id="rowId(index)"
          :key="row.key"
          class="wsb-row"
          :class="{ 'has-desc': row.includeLocalChanges }"
          role="option"
          tabindex="-1"
          :selected="row.selected"
          :active="activeIndex === index"
          :data-row="row.includeLocalChanges ? 'local' : row.branch"
          @mousemove="activeIndex = index"
          @click.stop="selectRow(row)"
        >
          <template #icon>
            <span class="wsb-glyph">
              <Icon name="worktree-branch" size="md" />
              <StatusDot v-if="row.includeLocalChanges" class="wsb-dot" status="unread" size="sm" />
            </span>
          </template>
          <span class="wsb-row-text">
            <span class="wsb-row-name">{{ row.branch }}</span>
            <span v-if="row.includeLocalChanges" class="wsb-row-desc">{{ t('worktreeCreate.branch.includeLocalChangesHint') }}</span>
          </span>
          <span v-if="row.remote" class="wsb-row-remote" data-remote>{{ row.remote }}</span>
        </MenuItem>
      </div>
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
    </div>
  </CreatePicker>
</template>

<style scoped>
.wsb {
  flex: 0 1 auto;
  min-width: 88px;
}
.wsb-chip-name {
  min-width: 0;
  overflow: hidden;
  font-weight: var(--weight-option-label);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wsb-glyph {
  position: relative;
  display: inline-flex;
  flex: none;
  line-height: 0;
}
.wsb-dot {
  position: absolute;
  top: calc(-1 * var(--space-05));
  right: calc(-1 * var(--space-05));
}
.wsb-hover {
  position: absolute;
  bottom: calc(100% + var(--space-1));
  left: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-05);
  width: max-content;
  max-width: min(320px, calc(100vw - var(--space-8)));
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
.wsb :deep(.wsb-panel) {
  width: min(320px, calc(100vw - var(--space-8)));
  overflow: hidden;
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
  min-height: var(--wsb-row-h);
}
.wsb-row.ui-menu-item.has-desc {
  align-items: flex-start;
}
.wsb-row.has-desc > .wsb-glyph,
.wsb-row.has-desc > :deep(.ui-menu-item__check) {
  margin-top: calc((var(--text-base) * var(--leading-normal) - var(--p-ic-md)) / 2);
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
.wsb-sep {
  flex: none;
}
.wsb-foot {
  display: flex;
  flex: none;
  flex-direction: column;
  padding-bottom: var(--space-05);
}
.wsb-foot-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 28px;
  padding: var(--space-05) var(--space-2);
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
</style>
