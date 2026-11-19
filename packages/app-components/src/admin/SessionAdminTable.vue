<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon, IconButton, Spinner } from '@moonshot-ai/app-ui';
import { basename } from '@moonshot-ai/app-core/lib';
import type { AppSession } from '@moonshot-ai/app-core/api';
import type { WorkspaceView } from '@moonshot-ai/app-core/client';
import { useKimiWebClient } from '@moonshot-ai/app-client/client';
import { formatAdminTime, formatAdminTimeCompact } from '@moonshot-ai/app-components';
import SessionAdminMenu, {
  type SessionAdminMenuAction,
  type SessionAdminMenuMode,
} from './SessionAdminMenu.vue';
import type { SessionAdminBatchDirection } from '@moonshot-ai/app-components';

const props = defineProps<{
  items: AppSession[];
  total: number;
  loading: boolean;
  workspaces: WorkspaceView[];
  batchRunning: SessionAdminBatchDirection | null;
}>();

const emit = defineEmits<{
  archiveSessions: [ids: string[]];
  restoreSessions: [ids: string[]];
}>();

const { t } = useI18n();
const client = useKimiWebClient();

const wsNameById = computed(() => new Map(props.workspaces.map((w) => [w.id, w.name])));

function titleOf(s: AppSession): string {
  return s.title !== '' ? s.title : (s.lastPrompt ?? s.id.slice(0, 12));
}

function workspaceName(s: AppSession): string {
  const name = s.workspaceId !== undefined ? wsNameById.value.get(s.workspaceId) : undefined;
  if (name !== undefined) return name;
  return s.cwd !== '' ? basename(s.cwd) : '—';
}

function completedText(s: AppSession): string | null {
  if (!s.archived) return null;
  return formatAdminTime(Date.parse(s.archivedAt ?? s.updatedAt));
}

function completedTextCompact(s: AppSession): string | null {
  if (!s.archived) return null;
  return formatAdminTimeCompact(Date.parse(s.archivedAt ?? s.updatedAt));
}

const selectedIds = computed(() => client.sessionAdminSelectedIds.value);
const selectedCount = computed(() => client.sessionAdminSelectedCount.value);
const openSelectedIds = computed(() => client.sessionAdminOpenSelectedIds.value);
const doneSelectedIds = computed(() => client.sessionAdminDoneSelectedIds.value);
const allMatching = computed(() => client.sessionAdminAllMatching.value);
const materializingAll = computed(() => client.sessionAdminMaterializingAll.value);
const selectionCounts = computed(() => ({
  total: selectedCount.value,
  open: openSelectedIds.value.length,
  done: doneSelectedIds.value.length,
}));

const pageEntries = computed(() =>
  props.items.map((s) => ({ id: s.id, archived: s.archived })),
);
const pageAllSelected = computed(
  () =>
    pageEntries.value.length > 0 &&
    pageEntries.value.every((e) => selectedIds.value.has(e.id)),
);
const pagePartiallySelected = computed(
  () => !pageAllSelected.value && pageEntries.value.some((e) => selectedIds.value.has(e.id)),
);

function togglePageSelection(): void {
  client.toggleSessionAdminPageSelection(pageEntries.value);
}

const renamingId = ref<string | null>(null);
const renameValue = ref('');
const renameInputRef = ref<HTMLInputElement | null>(null);

function startRename(s: AppSession): void {
  renamingId.value = s.id;
  renameValue.value = titleOf(s);
  void nextTick(() => {
    renameInputRef.value?.focus();
    renameInputRef.value?.select();
  });
}

async function commitRename(s: AppSession): Promise<void> {
  if (renamingId.value !== s.id) return;
  const value = renameValue.value.trim();
  renamingId.value = null;
  if (value === '' || value === titleOf(s)) return;
  await client.renameSession(s.id, value);
  await client.refreshSessionAdminSessions();
}

function onRenameKeydown(e: KeyboardEvent, s: AppSession): void {
  e.stopPropagation();
  if (e.key === 'Enter') void commitRename(s);
  else if (e.key === 'Escape') renamingId.value = null;
}

const menuMode = ref<SessionAdminMenuMode>('single');
const menuTarget = ref<AppSession | null>(null);
const adminMenuRef = ref<InstanceType<typeof SessionAdminMenu> | null>(null);

function onRowContextMenu(s: AppSession, e: MouseEvent): void {
  e.preventDefault();
  if (!(selectedIds.value.has(s.id) && selectedIds.value.size > 1)) {
    client.setSessionAdminSelection([{ id: s.id, archived: s.archived }]);
    menuMode.value = 'single';
    menuTarget.value = s;
  } else {
    menuMode.value = 'multi';
    menuTarget.value = null;
  }
  void adminMenuRef.value?.openAt(e.clientX, e.clientY);
}

function onRowMore(s: AppSession, e: MouseEvent): void {
  menuMode.value = 'rowActions';
  menuTarget.value = s;
  void adminMenuRef.value?.toggleAnchored(e, 'right');
}

function runRowPrimary(s: AppSession): void {
  if (s.archived) emit('restoreSessions', [s.id]);
  else emit('archiveSessions', [s.id]);
}

function onMenuAction(action: SessionAdminMenuAction): void {  if (menuMode.value === 'multi') {
    if (action === 'archive') emit('archiveSessions', [...openSelectedIds.value]);
    else if (action === 'restore') emit('restoreSessions', [...doneSelectedIds.value]);
    return;
  }
  const target = menuTarget.value;
  if (target === null) return;
  switch (action) {
    case 'open':
      void client.selectSession(target.id);
      break;
    case 'rename':
      startRename(target);
      break;
    case 'fork':
      void client.forkSession(target.id);
      break;
    case 'export':
      void client.exportSession(target.id);
      break;
    case 'archive':
      emit('archiveSessions', [target.id]);
      break;
    case 'restore':
      emit('restoreSessions', [target.id]);
      break;
  }
}
</script>

<template>
  <div class="sa-table-card" :class="{ 'is-loading': loading && items.length > 0 }">
    <table v-if="items.length > 0">
      <colgroup>
        <col class="sa-col-cb" />
        <col class="sa-col-title" />
        <col class="sa-col-ws" />
        <col class="sa-col-status" />
        <col />
        <col class="sa-col-time" />
        <col class="sa-col-time" />
        <col class="sa-col-act" />
      </colgroup>
      <thead>
        <tr>
          <th class="sa-col-cb">
            <button
              class="sa-cb"
              :class="{ on: pageAllSelected, ind: pagePartiallySelected }"
              type="button"
              :aria-label="t('admin.selectPageAll')"
              @click="togglePageSelection"
            >
              <Icon v-if="pageAllSelected" name="check" size="sm" />
              <Icon v-else-if="pagePartiallySelected" name="minus" size="sm" />
            </button>
          </th>
          <th v-if="selectedCount > 0" colspan="7" class="sa-batch">
            <div class="sa-batch-inner">
              <span class="sa-batch-count">
                {{
                  allMatching
                    ? t('admin.allMatchingSelected', { n: selectedCount })
                    : t('admin.batchSelected', { n: selectedCount })
                }}
              </span>
              <button
                v-if="allMatching"
                class="sa-batch-link"
                type="button"
                @click="client.clearSessionAdminSelection()"
              >
                {{ t('admin.clearSelection') }}
              </button>
              <button
                v-else-if="pageAllSelected && total > selectedCount"
                class="sa-batch-link"
                type="button"
                :disabled="materializingAll"
                @click="client.selectSessionAdminAllMatching()"
              >
                {{
                  materializingAll
                    ? t('admin.materializingAll')
                    : t('admin.selectAllMatching', { total })
                }}
              </button>
              <button
                class="sa-btn-q sa-btn-q--primary"
                type="button"
                :disabled="selectionCounts.open === 0 || batchRunning !== null"
                @click="emit('archiveSessions', [...openSelectedIds])"
              >
                <Spinner v-if="batchRunning === 'archive'" size="sm" />
                <Icon v-else name="state-done" size="sm" />
                {{ t('admin.markDone') }}
              </button>
              <button
                class="sa-btn-q"
                type="button"
                :disabled="selectionCounts.done === 0 || batchRunning !== null"
                @click="emit('restoreSessions', [...doneSelectedIds])"
              >
                <Spinner v-if="batchRunning === 'restore'" size="sm" />
                <Icon v-else name="undo" size="sm" />
                {{ t('admin.reopen') }}
              </button>
            </div>
          </th>
          <template v-else>
            <th>{{ t('admin.colTitle') }}</th>
            <th>{{ t('admin.colWorkspace') }}</th>
            <th>{{ t('admin.colStatus') }}</th>
            <th>{{ t('admin.colPrompt') }}</th>
            <th class="sa-c-time">{{ t('admin.colUpdated') }}</th>
            <th class="sa-c-time">{{ t('admin.colCompleted') }}</th>
            <th>{{ t('admin.colActions') }}</th>
          </template>
        </tr>
      </thead>
      <tbody>
        <tr v-for="s in items" :key="s.id" @contextmenu="onRowContextMenu(s, $event)">
          <td class="sa-col-cb">
            <button
              class="sa-cb"
              :class="{ on: selectedIds.has(s.id) }"
              type="button"
              :aria-label="s.id"
              @click="client.toggleSessionAdminSelection(s.id, s.archived)"
            >
              <Icon v-if="selectedIds.has(s.id)" name="check" size="sm" />
            </button>
          </td>
          <td>
            <input
              v-if="renamingId === s.id"
              ref="renameInputRef"
              v-model="renameValue"
              class="sa-rename"
              type="text"
              @keydown="onRenameKeydown($event, s)"
              @blur="void commitRename(s)"
            />
            <span v-else class="sa-title" :title="titleOf(s)">{{ titleOf(s) }}</span>
          </td>
          <td>
            <span class="sa-ws">
              <span>{{ workspaceName(s) }}</span>
            </span>
          </td>
          <td>
            <span class="sa-st" :class="s.archived ? 'sa-st--done' : 'sa-st--open'">
              <Icon :name="s.archived ? 'state-done' : 'state-open'" size="sm" />
              {{ s.archived ? t('admin.statusDone') : t('admin.statusOpen') }}
            </span>
          </td>
          <td class="sa-prompt" :title="s.lastPrompt">
            <span :class="{ 'sa-none': s.lastPrompt === undefined }">
              {{ s.lastPrompt ?? '—' }}
            </span>
          </td>
          <td class="sa-c-time">
            <span class="sa-time sa-time--full">{{ formatAdminTime(Date.parse(s.updatedAt)) }}</span>
            <span class="sa-time sa-time--compact">{{ formatAdminTimeCompact(Date.parse(s.updatedAt)) }}</span>
          </td>
          <td class="sa-c-time">
            <template v-if="completedText(s) !== null">
              <span class="sa-time sa-time--full">{{ completedText(s) }}</span>
              <span class="sa-time sa-time--compact">{{ completedTextCompact(s) }}</span>
            </template>
            <span v-else class="sa-time sa-none">—</span>
          </td>
          <td>
            <div class="sa-act">
              <!-- Row lifecycle action as an icon (sidebar-row language):
                   state-done completes an open row, undo reopens a done one —
                   tooltips carry the labels. -->
              <IconButton
                size="sm"
                :label="s.archived ? t('admin.reopen') : t('admin.markDone')"
                :tooltip="s.archived ? t('admin.reopen') : t('admin.markDone')"
                @click="runRowPrimary(s)"
              >
                <Icon :name="s.archived ? 'undo' : 'state-done'" />
              </IconButton>
              <IconButton
                size="sm"
                :label="t('admin.moreActions')"
                :tooltip="t('admin.moreActions')"
                @click="onRowMore(s, $event)"
              >
                <Icon name="dots-horizontal" />
              </IconButton>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
    <div v-else-if="loading" class="sa-state">
      <Spinner size="lg" :label="t('admin.loading')" />
    </div>
    <div v-else class="sa-state">
      <p class="sa-empty">{{ t('admin.empty') }}</p>
    </div>
  </div>

  <SessionAdminMenu
    ref="adminMenuRef"
    :mode="menuMode"
    :target-archived="menuTarget?.archived"
    :counts="selectionCounts"
    @action="onMenuAction"
  />
</template>

<style scoped>
.sa-table-card {
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-lg);
  background: var(--color-bg);
  overflow-x: auto;
  container-type: inline-size;
  transition: opacity var(--duration-fast) var(--ease-out);
}
.sa-table-card.is-loading {
  opacity: 0.45;
  pointer-events: none;
}

table {
  width: 100%;
  min-width: 640px;
  border-collapse: collapse;
  table-layout: fixed;
}
.sa-col-cb {
  width: 36px;
}
.sa-col-title {
  width: max(200px, 20%);
}
.sa-col-ws {
  width: 116px;
}
.sa-col-status {
  width: 88px;
}
.sa-col-time {
  width: 140px;
}
.sa-col-act {
  width: 84px;
}

.sa-time--compact {
  display: none;
}
@container (max-width: 1020px) {
  .sa-col-time {
    width: 108px;
  }
  .sa-time--full {
    display: none;
  }
  .sa-time--compact {
    display: inline;
  }
}
@container (max-width: 760px) {
  col.sa-col-time,
  .sa-c-time {
    display: none;
  }
  .sa-col-ws {
    width: 96px;
  }
}

thead th {
  height: 32px;
  padding: 0 var(--space-3);
  border-bottom: var(--p-hairline) solid var(--color-line);
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  text-align: left;
  white-space: nowrap;
  user-select: none;
}
th.sa-col-cb,
td.sa-col-cb {
  padding-right: 0;
}
tbody td {
  height: 40px;
  padding: 0 var(--space-3);
  border-bottom: var(--p-hairline) solid var(--color-subtle);
  font-size: var(--text-sm);
  line-height: var(--leading-tight);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
}
tbody tr:last-child td {
  border-bottom: none;
}
tbody tr {
  transition: background var(--duration-fast) var(--ease-out);
}
tbody tr:hover {
  background: var(--color-hover);
}

.sa-cb {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border: var(--p-hairline) solid var(--color-line-strong);
  border-radius: var(--radius-xs);
  color: var(--color-text-on-accent);
  vertical-align: middle;
  transition:
    background var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast) var(--ease-out);
}
.sa-cb:hover {
  border-color: var(--color-text-faint);
}
.sa-cb.on,
.sa-cb.ind {
  background: var(--color-accent);
  border-color: var(--color-accent);
}

.sa-batch-inner {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.sa-batch-count {
  margin-right: var(--space-1);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  white-space: nowrap;
  user-select: none;
}
.sa-batch-link {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 var(--space-1);
  border: none;
  background: transparent;
  color: var(--color-accent);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  white-space: nowrap;
}
.sa-batch-link:hover {
  text-decoration: underline;
}
.sa-batch-link:disabled {
  color: var(--color-text-faint);
  cursor: default;
  text-decoration: none;
}
.sa-btn-q {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  height: 24px;
  padding: 0 var(--space-2);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  line-height: 1;
  transition:
    background var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}
.sa-btn-q:hover {
  background: var(--color-hover);
}
.sa-btn-q:disabled {
  opacity: 0.42;
  cursor: default;
}
.sa-btn-q:disabled:hover {
  background: transparent;
}
.sa-btn-q :first-child {
  color: var(--color-text-muted);
}
.sa-btn-q:hover :first-child {
  color: var(--color-text);
}
.sa-btn-q--primary,
.sa-btn-q--primary :first-child {
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: var(--color-text-on-accent);
}
.sa-btn-q--primary:hover,
.sa-btn-q--primary:hover :first-child {
  border-color: var(--color-accent-hover);
  background: var(--color-accent-hover);
  color: var(--color-text-on-accent);
}
.sa-btn-q--primary:disabled,
.sa-btn-q--primary:disabled:hover,
.sa-btn-q--primary:disabled :first-child,
.sa-btn-q--primary:disabled:hover :first-child {
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: var(--color-text-on-accent);
}

.sa-st {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
}
.sa-st--open {
  color: var(--color-success);
}
.sa-st--done {
  color: var(--color-done);
}

.sa-title {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text);
  font-weight: var(--weight-option-label);
}

.sa-rename {
  width: 100%;
  height: 26px;
  padding: 0 var(--space-1-5);
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-sm);
  outline: none;
  box-shadow: 0 0 0 2px var(--color-accent-bd);
  background: var(--color-bg);
  color: var(--color-text);
  font-family: inherit;
  font-size: var(--text-sm);
}

.sa-ws {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  color: var(--color-text-muted);
}
.sa-ws span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sa-prompt {
  color: var(--color-text-muted);
}

.sa-time {
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.sa-none {
  color: var(--color-text-faint);
}

.sa-act {
  display: flex;
  align-items: center;
  gap: var(--space-05);
}

.sa-state {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: calc(var(--space-8) + var(--space-6)) var(--space-4);
}
.sa-empty {
  color: var(--color-text-faint);
  font-size: var(--text-sm);
}
</style>
