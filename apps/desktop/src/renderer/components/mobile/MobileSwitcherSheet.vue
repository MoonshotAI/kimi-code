<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Session, WorkspaceGroup, WorkspaceView } from '../../types';
import type { SessionCreatedSource } from '../../../shared/track-events';
import {
  copyTextToClipboard,
  loadMobileSwitcherViewMode,
  nativePath,
  saveMobileSwitcherViewMode,
  type SidebarViewMode,
} from '@moonshot-ai/app-core/lib';
import { SESSIONS_EXPAND_BATCH } from '@moonshot-ai/app-client/client';
import { BottomSheet, RcDeviceSwitcher } from '@moonshot-ai/app-components';
import { Icon, IconButton, Menu, MenuItem, SegmentedControl, Tooltip } from '@moonshot-ai/app-ui';
import { WorkspaceIcon } from '@moonshot-ai/app-components/support';

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    groups: WorkspaceGroup[];
    flatSessions: Session[];
    pinnedSessions: Session[];
    flatHasMore?: boolean;
    flatLoadingMore?: boolean;
    activeWorkspaceId: string | null;
    activeId: string;
    attentionBySession?: Record<string, number>;
    attentionByWorkspace?: Record<string, number>;
  }>(),
  {
    flatHasMore: false,
    flatLoadingMore: false,
    activeWorkspaceId: null,
    attentionBySession: () => ({}),
    attentionByWorkspace: () => ({}),
  },
);

const emit = defineEmits<{
  'update:modelValue': [open: boolean];
  select: [selection: { sessionId: string; source: SessionCreatedSource }];
  create: [];
  createInWorkspace: [workspaceId: string];
  addWorkspace: [];
  rename: [id: string, title: string];
  archive: [id: string];
  delete: [id: string];
  deleteWorkspace: [workspaceId: string];
  loadMore: [workspaceId: string];
  ensureFlatSessions: [];
  loadMoreFlatSessions: [];
}>();

function close(): void {
  emit('update:modelValue', false);
}

function onSelectSession(id: string): void {
  emit('select', { sessionId: id, source: 'sidebar' });
  close();
}

function onCreateInWorkspace(id: string): void {
  emit('createInWorkspace', id);
  close();
}

function onCreate(): void {
  emit('create');
  close();
}

function onAddWorkspace(): void {
  emit('addWorkspace');
  close();
}

const viewMode = ref<SidebarViewMode>(loadMobileSwitcherViewMode());
const viewOptions = computed(() => [
  { value: 'flat', label: t('mobile.viewFlat') },
  { value: 'grouped', label: t('mobile.viewGrouped') },
]);
watch(viewMode, (mode) => saveMobileSwitcherViewMode(mode));

watch(
  () => [props.modelValue, viewMode.value] as const,
  ([open, mode]) => {
    if (open && mode === 'flat') emit('ensureFlatSessions');
  },
  { immediate: true },
);

const flatRows = computed<Session[]>(() => {
  const seen = new Set<string>();
  const merged: Session[] = [];
  for (const s of [...props.flatSessions, ...props.pinnedSessions]) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    merged.push(s);
  }
  return merged.sort(
    (a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime(),
  );
});

const sortedGroups = computed<WorkspaceGroup[]>(() => {
  const latestMs = (g: WorkspaceGroup): number =>
    g.sessions.length > 0 ? new Date(g.sessions[0]!.updatedAt ?? 0).getTime() : 0;
  return props.groups
    .map((g, index) => ({ g, index, ms: latestMs(g) }))
    .sort((a, b) => b.ms - a.ms || a.index - b.index)
    .map((x) => x.g);
});

const collapsedIds = ref<Set<string>>(new Set());

function isCollapsed(id: string): boolean {
  return collapsedIds.value.has(id);
}

function toggleCollapse(id: string): void {
  const next = new Set(collapsedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsedIds.value = next;
  menuFor.value = null;
  wsMenuFor.value = null;
}

const visibleLimits = ref<Map<string, number>>(new Map());

function displayLimitFor(g: WorkspaceGroup): number {
  return visibleLimits.value.get(g.workspace.id) ?? g.initialCount;
}

function visibleSessions(g: WorkspaceGroup): Session[] {
  const head = g.sessions.slice(0, displayLimitFor(g));
  if (props.activeId && !head.some((s) => s.id === props.activeId)) {
    const active = g.sessions.find((s) => s.id === props.activeId);
    if (active) return [...head, active];
  }
  return head;
}

function canExpand(g: WorkspaceGroup): boolean {
  return g.sessions.length > displayLimitFor(g) || g.hasMore || g.loadingMore;
}

function canCollapse(g: WorkspaceGroup): boolean {
  return displayLimitFor(g) > g.initialCount;
}

function onExpand(id: string): void {
  const group = props.groups.find((g) => g.workspace.id === id);
  if (!group) return;
  const next = displayLimitFor(group) + SESSIONS_EXPAND_BATCH;
  const limits = new Map(visibleLimits.value);
  limits.set(id, next);
  visibleLimits.value = limits;
  if (group.sessions.length < next && group.hasMore) {
    emit('loadMore', id);
  }
}

function onCollapse(id: string): void {
  if (!visibleLimits.value.has(id)) return;
  const limits = new Map(visibleLimits.value);
  limits.delete(id);
  visibleLimits.value = limits;
}

function wsAttention(id: string): number {
  return props.attentionByWorkspace[id] ?? 0;
}

const menuFor = ref<string | null>(null);

function toggleMenu(id: string): void {
  menuFor.value = menuFor.value === id ? null : id;
  wsMenuFor.value = null;
}
function onRename(s: Session): void {
  menuFor.value = null;
  const next = typeof window !== 'undefined' ? window.prompt(t('sidebar.rename'), s.title) : null;
  const title = next?.trim();
  if (title) emit('rename', s.id, title);
}
function onArchive(id: string): void {
  menuFor.value = null;
  emit('archive', id);
}
function onDelete(id: string): void {
  menuFor.value = null;
  emit('delete', id);
}

const wsMenuFor = ref<string | null>(null);

function toggleWsMenu(id: string): void {
  wsMenuFor.value = wsMenuFor.value === id ? null : id;
  menuFor.value = null;
}
function onCopyWsPath(ws: WorkspaceView): void {
  void copyTextToClipboard(nativePath(ws.root));
  wsMenuFor.value = null;
}
function onDeleteWorkspace(ws: WorkspaceView): void {
  wsMenuFor.value = null;
  emit('deleteWorkspace', ws.id);
}
</script>

<template>
  <BottomSheet
    :model-value="modelValue"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <RcDeviceSwitcher />

    <div class="actions">
      <button type="button" class="newrow" @click="onCreate">
        <Icon name="chat-new" size="sm" />
        {{ t('sidebar.newChat') }}
      </button>
      <button type="button" class="newrow secondary" @click="onAddWorkspace">
        <Icon name="folder" size="sm" />
        {{ t('sidebar.newWorkspace') }}
      </button>
    </div>

    <div class="view-tabs">
      <SegmentedControl v-model="viewMode" :options="viewOptions" size="sm" />
    </div>

    <div v-if="viewMode === 'grouped'" class="mlist">
      <div v-if="sortedGroups.length === 0" class="mempty">
        {{ t('workspace.noWorkspace') }}
      </div>

      <div v-for="g in sortedGroups" :key="g.workspace.id" class="mgroup">
        <div
          class="mgh"
          :class="{ on: g.workspace.id === activeWorkspaceId }"
          @click="toggleCollapse(g.workspace.id)"
        >
          <WorkspaceIcon v-if="g.workspace.hostId !== undefined" class="mgh-folder" :host-id="g.workspace.hostId" size="sm" status="all" />
          <Icon v-else-if="isCollapsed(g.workspace.id)" class="mgh-folder" name="folder-closed" size="sm" />
          <Icon v-else class="mgh-folder" name="folder" size="sm" />

          <span class="mgh-name">{{ g.workspace.name }}</span>
          <Tooltip :text="nativePath(g.workspace.root)">
            <span class="mgh-path">{{ g.workspace.shortPath }}</span>
          </Tooltip>

          <span
            v-if="isCollapsed(g.workspace.id) && wsAttention(g.workspace.id) > 0"
            class="att"
          >{{ wsAttention(g.workspace.id) }}</span>

          <IconButton
            size="lg"
            class="mgh-more"
            :label="t('sidebar.options')"
            @click.stop="toggleWsMenu(g.workspace.id)"
          >
            <Icon name="dots-horizontal" size="md" />
          </IconButton>

          <IconButton
            size="lg"
            class="mgh-add"
            :label="t('workspace.newInGroup')"
            @click.stop="onCreateInWorkspace(g.workspace.id)"
          >
            <Icon name="chat-new" size="md" />
          </IconButton>

          <Menu v-if="wsMenuFor === g.workspace.id" class="kmenu wsmenu" @click.stop>
            <MenuItem size="lg" @click="onCopyWsPath(g.workspace)">
              {{ t('sidebar.copyPath') }}
            </MenuItem>
            <MenuItem size="lg" danger @click="onDeleteWorkspace(g.workspace)">{{ t('sidebar.delete') }}</MenuItem>
          </Menu>
        </div>

        <div v-show="!isCollapsed(g.workspace.id)">
          <div v-if="g.sessions.length === 0" class="mempty small">{{ t('sidebar.noSessions') }}</div>
          <div
            v-for="s in visibleSessions(g)"
            :key="s.id"
            class="srow"
            :class="{ cur: s.id === activeId }"
            @click="onSelectSession(s.id)"
          >
            <span class="t" :class="{ run: s.busy, aborted: !s.busy && (attentionBySession[s.id] ?? 0) === 0 && s.lastTurnReason === 'failed' }">{{ s.title }}</span>
            <span v-if="(attentionBySession[s.id] ?? 0) > 0" class="att">{{ attentionBySession[s.id] }}</span>
            <span class="time">{{ s.time }}</span>
            <IconButton
              size="lg"
              class="kb"
              :label="t('sidebar.options')"
              @click.stop="toggleMenu(s.id)"
            >
              <Icon name="dots-horizontal" size="md" />
            </IconButton>

            <Menu v-if="menuFor === s.id" class="kmenu" @click.stop>
              <MenuItem size="lg" @click="onRename(s)">{{ t('sidebar.rename') }}</MenuItem>
              <MenuItem size="lg" @click="onArchive(s.id)">{{ t('sidebar.archive') }}</MenuItem>
              <MenuItem separator />
              <MenuItem size="lg" danger @click="onDelete(s.id)"><Icon name="trash" size="sm" /> {{ t('sidebar.delete') }}</MenuItem>
            </Menu>
          </div>
          <div v-if="canExpand(g) || canCollapse(g)" class="mshow-more-row">
            <button
              v-if="canExpand(g)"
              type="button"
              class="mshow-more"
              :disabled="g.loadingMore"
              @click.stop="onExpand(g.workspace.id)"
            >
              <Icon name="chevron-down" size="sm" />
              {{ g.loadingMore ? t('sidebar.loadingMore') : t('sidebar.showMore') }}
            </button>
            <span v-if="canExpand(g) && canCollapse(g)" class="mshow-more-sep" aria-hidden="true">·</span>
            <button
              v-if="canCollapse(g)"
              type="button"
              class="mshow-more"
              @click.stop="onCollapse(g.workspace.id)"
            >
              <Icon name="chevron-up" size="sm" />
              {{ t('sidebar.showLess') }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <div v-else class="mlist">
      <div v-if="flatRows.length === 0" class="mempty">{{ t('sidebar.noSessions') }}</div>
      <div
        v-for="s in flatRows"
        :key="s.id"
        class="srow srow-flat"
        :class="{ cur: s.id === activeId }"
        @click="onSelectSession(s.id)"
      >
        <span class="srow-main">
          <span class="t" :class="{ run: s.busy, aborted: !s.busy && (attentionBySession[s.id] ?? 0) === 0 && s.lastTurnReason === 'failed' }">{{ s.title }}</span>
          <span class="srow-sub">{{ s.workspaceName ?? s.cwdLabel ?? '-' }}</span>
        </span>
        <span v-if="(attentionBySession[s.id] ?? 0) > 0" class="att">{{ attentionBySession[s.id] }}</span>
        <span class="time">{{ s.time }}</span>
        <IconButton
          size="lg"
          class="kb"
          :label="t('sidebar.options')"
          @click.stop="toggleMenu(s.id)"
        >
          <Icon name="dots-horizontal" size="md" />
        </IconButton>

        <Menu v-if="menuFor === s.id" class="kmenu" @click.stop>
          <MenuItem size="lg" @click="onRename(s)">{{ t('sidebar.rename') }}</MenuItem>
          <MenuItem size="lg" @click="onArchive(s.id)">{{ t('sidebar.archive') }}</MenuItem>
          <MenuItem separator />
          <MenuItem size="lg" danger @click="onDelete(s.id)"><Icon name="trash" size="sm" /> {{ t('sidebar.delete') }}</MenuItem>
        </Menu>
      </div>
      <div v-if="flatHasMore" class="mshow-more-row">
        <button
          type="button"
          class="mshow-more"
          :disabled="flatLoadingMore"
          @click.stop="emit('loadMoreFlatSessions')"
        >
          <Icon name="chevron-down" size="sm" />
          {{ flatLoadingMore ? t('sidebar.loadingMore') : t('sidebar.showMore') }}
        </button>
      </div>
    </div>
  </BottomSheet>
</template>

<style scoped>
.actions {
  padding: 0 var(--space-2) var(--space-2);
  border-bottom: var(--p-hairline) solid var(--color-line);
  margin-bottom: var(--space-1);
}
.newrow {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 44px;
  padding: var(--space-2) var(--space-3);
  background: none;
  border: none;
  border-radius: var(--radius-md);
  color: var(--color-accent);
  font-family: var(--font-ui);
  font-weight: var(--weight-medium);
  font-size: var(--text-base);
  cursor: pointer;
  text-align: left;
}
.newrow:hover { background: var(--color-hover); }
.newrow:active { background: var(--color-surface-sunken); }
.newrow.secondary {
  color: var(--color-text-muted);
  font-weight: var(--weight-regular);
}
.newrow.secondary:active { color: var(--color-text); }

.view-tabs { padding: var(--space-1) var(--space-3) var(--space-2); }
.view-tabs :deep(.ui-seg) { display: flex; width: 100%; }
.view-tabs :deep(.ui-seg__item) { flex: 1; justify-content: center; }

.mlist {
  --m-pad: 16px;
  --m-gutter: 15px;
  --m-gap: 8px;
  --m-indent: calc(var(--m-pad) + var(--m-gutter) + var(--m-gap));
  padding-bottom: var(--space-1);
}
.mempty {
  padding: var(--space-6) var(--space-4);
  text-align: center;
  color: var(--color-text-faint);
  font-size: var(--text-base);
}
.mempty.small { padding: 10px 16px 12px var(--m-indent); text-align: left; font-size: var(--text-xs); }

.mgroup { padding-top: var(--space-2); }
.mgh {
  display: flex;
  align-items: center;
  gap: var(--m-gap);
  min-height: 44px;
  margin: 0 var(--space-2);
  padding: 0 calc(var(--m-pad) - var(--space-2));
  border-radius: var(--radius-md);
  cursor: pointer;
  -webkit-user-select: none;
  user-select: none;
  position: relative;
}
.mgh:hover { background: var(--color-hover); }
.mgh:active { background: var(--color-surface-sunken); }
.mgh-folder { flex: none; color: var(--color-text-muted); }
.mgh-name {
  flex: none;
  max-width: 50%;
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mgh-path {
  flex: 1;
  min-width: 0;
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mgh-more { margin: 0 calc(-1 * var(--space-2)); }
.mgh-add { margin: 0 calc(-1 * var(--space-2)) 0 0; }
.mgh-add:active { color: var(--color-text); background: var(--color-hover); }
.mgh-more:active { color: var(--color-text); background: var(--color-hover); }

.srow {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 44px;
  margin: 1px var(--space-2);
  padding: 0 calc(var(--m-pad) - var(--space-2)) 0 calc(var(--m-indent) - var(--space-2));
  border-radius: var(--radius-md);
  cursor: pointer;
  -webkit-user-select: none;
  user-select: none;
  position: relative;
}
.srow:hover { background: var(--color-hover); }
.srow:active { background: var(--color-surface-sunken); }
.srow.cur { background: var(--color-accent-soft); box-shadow: inset 0 0 0 1px var(--color-accent-bd); }
.srow .t {
  flex: 1;
  min-width: 0;
  font-size: var(--text-sm);
  color: var(--color-text);
  font-weight: var(--weight-caption);
  line-height: var(--leading-tight);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.srow.cur .t { color: var(--color-accent-hover); }

.srow .t.run { position: relative; }
.srow .t.run::before {
  content: '';
  position: absolute;
  left: -14px;
  top: 50%;
  transform: translateY(-50%);
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  background: var(--color-accent);
  animation: mRunPulse 1.4s ease-in-out infinite;
}
@keyframes mRunPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
.srow .t.aborted { position: relative; }
.srow .t.aborted::before {
  content: '';
  position: absolute;
  left: -14px;
  top: 50%;
  transform: translateY(-50%);
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  background: var(--color-danger);
}
.srow .time {
  flex: none;
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
  color: var(--color-text-faint);
}
.att {
  flex: none;
  font-family: var(--font-mono);
  font-size: max(9px, calc(var(--text-base) - 4px));
  color: var(--color-text-on-accent);
  background: var(--color-warning);
  border-radius: var(--radius-full);
  padding: 1px 7px;
}
.srow .kb { flex: none; margin: 0 calc(-1 * var(--space-2)) 0 0; }
.srow .kb:active { color: var(--color-text); background: var(--color-hover); }

.srow-flat { min-height: 52px; }
.srow-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.srow-main .t { flex: none; }
.srow-sub {
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kmenu {
  position: absolute;
  right: 12px;
  top: 44px;
  z-index: var(--z-dropdown);
  min-width: 96px;
  overflow: hidden;
}

.wsmenu {
  top: calc(100% - 4px);
  right: var(--m-pad);
  min-width: 132px;
}

.mshow-more-row {
  display: flex;
  align-items: center;
  padding-left: calc(var(--m-indent) - var(--space-3));
}
.mshow-more {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 44px;
  padding: var(--space-1) var(--space-3);
  background: none;
  border: none;
  border-radius: var(--radius-md);
  color: var(--color-text-muted);
  font-size: var(--text-base);
  cursor: pointer;
  text-align: left;
}
.mshow-more:active { color: var(--color-accent-hover); background: var(--color-hover); }
.mshow-more-sep {
  margin: 0 var(--space-1);
  color: var(--color-text-faint);
  user-select: none;
}
</style>
