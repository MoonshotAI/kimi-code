<!-- Session admin page (/admin/sessions): the cross-workspace management view
     opened from the sidebar's list-options menu. P2 = page head, filter bar,
     the server-side paged table, and the pager; P3 = selection/batch, row
     actions, context menus. The filter bar is a QUERY FORM (antd Pro
     semantics): controls edit a local draft only — nothing is requested until
     查询 / Enter (blocked while any dropdown is open) applies the draft
     through the facade in one shot, and 重置 restores defaults the same way.
     Pagination still fetches immediately. Mounted next to ConversationPane in
     App.vue and switched with v-show, so the chat (and its session) stays
     alive underneath. Page-private by design (see
     docs/plans/2026-08-15-session-admin-page.md) — nothing here promotes to
     app-ui; the desktop copy and this one are kept in lockstep. -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, Icon, IconButton, Tooltip } from '@moonshot-ai/app-ui';
import { isMacosDesktop } from '@moonshot-ai/app-core/lib';
import { useKimiWebClient } from '@moonshot-ai/app-client/client';
import type { SessionAdminStatusFilter } from '@moonshot-ai/app-client/client';
import type { SessionAdminBatchDirection } from '@moonshot-ai/app-components';
import { FilterSelect } from '@moonshot-ai/app-components';
import { MultiSelectMenu } from '@moonshot-ai/app-components';
import { SessionAdminTable } from '@moonshot-ai/app-components';
import { SessionAdminPagination } from '@moonshot-ai/app-components';

const { t } = useI18n();
const client = useKimiWebClient();

defineProps<{
  /** Direction of the in-flight admin batch (null = idle) — the table's batch
   *  bar spins the running button and disables both while a request is open. */
  batchRunning: SessionAdminBatchDirection | null;
}>();

// Batch archive/restore intents bubble up to App.vue, which owns the shared
// actionToast channel (single-row actions ride the same batch endpoint).
const emit = defineEmits<{
  archiveSessions: [ids: string[]];
  restoreSessions: [ids: string[]];
}>();

const items = computed(() => client.sessionAdminItems.value);
const total = computed(() => client.sessionAdminTotal.value);
const loading = computed(() => client.sessionAdminLoading.value);
const page = computed(() => client.sessionAdminPage.value);
const pageSize = computed(() => client.sessionAdminPageSize.value);
const workspaces = computed(() =>
  client.workspacesView.value.map((w) => ({ id: w.id, name: w.name })),
);

// ---------------------------------------------------------------------------
// Filter draft (query form): the controls only edit this local state. The
// facade's applied filters change exclusively via 查询 / 重置 — one atomic
// applySessionAdminFilters call (page reset + exactly one request).
// ---------------------------------------------------------------------------

/** Updated-time presets (GitHub-style relative windows): the pick maps onto
 *  the facade's `updatedTo` bound — the local calendar day N days back. */
type TimePreset = 'all' | '3d' | '7d' | '30d';
const TIME_PRESET_DAYS: Record<Exclude<TimePreset, 'all'>, number> = {
  '3d': 3,
  '7d': 7,
  '30d': 30,
};

/** Preset → 'YYYY-MM-DD' of the local day N days ago ('all' → '' unbounded). */
function presetToUpdatedTo(preset: TimePreset): string {
  if (preset === 'all') return '';
  const d = new Date();
  d.setDate(d.getDate() - TIME_PRESET_DAYS[preset]);
  const pad2 = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Reverse of presetToUpdatedTo for the one-time seed (a bound that matches
 *  no preset — only reachable from a pre-preset build — collapses to 'all'). */
function updatedToToPreset(updatedTo: string): TimePreset {
  for (const preset of ['3d', '7d', '30d'] as const) {
    if (presetToUpdatedTo(preset) === updatedTo) return preset;
  }
  return 'all';
}

// Draft seeding from the facade's applied values. The page is v-show-kept and
// filters can also move EXTERNALLY (the workspace home's 查看更多 pre-selects
// its workspace), so the draft re-seeds on every entry — not just at mount.
const draftWorkspaces = ref<string[]>([]);
const draftStatus = ref<SessionAdminStatusFilter>('all');
const draftTimePreset = ref<TimePreset>('all');

function seedDraft(): void {
  const applied = client.sessionAdminFilters.value;
  draftWorkspaces.value = [...applied.workspaceIds];
  draftStatus.value = applied.status;
  draftTimePreset.value =
    applied.updatedFrom === '' ? updatedToToPreset(applied.updatedTo) : 'all';
}
seedDraft();
watch(
  () => client.mainView.value,
  (view) => {
    if (view === 'sessionAdmin') seedDraft();
  },
);

function applyQuery(): void {
  client.applySessionAdminFilters({
    workspaceIds: [...draftWorkspaces.value],
    status: draftStatus.value,
    updatedFrom: '',
    updatedTo: presetToUpdatedTo(draftTimePreset.value),
  });
}

function resetQuery(): void {
  draftWorkspaces.value = [];
  draftStatus.value = 'all';
  draftTimePreset.value = 'all';
  client.applySessionAdminFilters({
    workspaceIds: [],
    status: 'all',
    updatedFrom: '',
    updatedTo: '',
  });
}

// Enter queries — but never while an overlay (a select dropdown) is open:
// its Enter belongs to the overlay.
const wsMenuRef = ref<InstanceType<typeof MultiSelectMenu> | null>(null);
const statusSelectRef = ref<InstanceType<typeof FilterSelect> | null>(null);
const timeSelectRef = ref<InstanceType<typeof FilterSelect> | null>(null);
const anyOverlayOpen = computed(
  () =>
    wsMenuRef.value?.open === true ||
    statusSelectRef.value?.open === true ||
    timeSelectRef.value?.open === true,
);

function onFilterEnter(): void {
  if (anyOverlayOpen.value) return;
  applyQuery();
}

const statusOptions = computed(() => [
  { value: 'all', label: t('admin.statusAll') },
  { value: 'open', label: t('admin.statusOpen'), dot: 'open' as const },
  { value: 'done', label: t('admin.statusDone'), dot: 'done' as const },
]);

const timeOptions = computed(() => [
  { value: 'all', label: t('admin.timeAll') },
  { value: '3d', label: t('admin.timeDaysAgo', { n: 3 }) },
  { value: '7d', label: t('admin.timeDaysAgo', { n: 7 }) },
  { value: '30d', label: t('admin.timeDaysAgo', { n: 30 }) },
]);
</script>

<template>
  <!-- `con` hooks App.vue's desktop grid pin (`.app:not(.mobile) > .con`) —
       the same slot ConversationPane occupies; the two never show together. -->
  <section class="con session-admin" :class="{ 'macos-desktop': isMacosDesktop }">
    <!-- Title bar: a back IconButton (chevron-left, tooltip) + the page title
         in the 48px top strip (window-drag region on macOS); the collapsed-
         sidebar clearance rules in App.vue pad THIS bar, so the table below
         always spans the full pane width. -->
    <header class="sa-head">
      <Tooltip :text="t('admin.back')">
        <IconButton
          size="sm"
          :label="t('admin.back')"
          @click="client.closeSessionAdmin()"
        >
          <Icon name="chevron-left" />
        </IconButton>
      </Tooltip>
      <h1 class="sa-title">{{ t('admin.title') }}</h1>
    </header>
    <div class="sa-scroll">
      <div class="sa-page">
        <p class="sa-subtitle">{{ t('admin.subtitle') }}</p>

        <div class="sa-filters" @keydown.enter="onFilterEnter">
          <span class="sa-f-label">{{ t('admin.filterWorkspace') }}</span>
          <MultiSelectMenu
            ref="wsMenuRef"
            v-model="draftWorkspaces"
            :options="workspaces"
            :aria-label="t('admin.filterWorkspace')"
          />
          <span class="sa-f-label">{{ t('admin.filterStatus') }}</span>
          <FilterSelect
            ref="statusSelectRef"
            v-model="draftStatus"
            :options="statusOptions"
            :aria-label="t('admin.filterStatus')"
          />
          <span class="sa-f-label">{{ t('admin.filterTime') }}</span>
          <FilterSelect
            ref="timeSelectRef"
            v-model="draftTimePreset"
            :options="timeOptions"
            :aria-label="t('admin.filterTime')"
          />
          <div class="sa-f-actions">
            <Button variant="primary" size="sm" @click="applyQuery">
              {{ t('admin.query') }}
            </Button>
            <Button variant="ghost" size="sm" @click="resetQuery">
              {{ t('admin.reset') }}
            </Button>
          </div>
        </div>

        <SessionAdminTable
          :items="items"
          :total="total"
          :loading="loading"
          :workspaces="client.workspacesView.value"
          :batch-running="batchRunning"
          @archive-sessions="emit('archiveSessions', $event)"
          @restore-sessions="emit('restoreSessions', $event)"
        />
        <SessionAdminPagination
          :page="page"
          :page-size="pageSize"
          :total="total"
          @update:page="client.setSessionAdminPage($event)"
          @update:page-size="client.setSessionAdminPageSize($event)"
        />
      </div>
    </div>
  </section>
</template>

<style scoped>
.session-admin {
  display: flex;
  flex-direction: column;
  min-width: 0;
  height: 100%;
  background: var(--color-bg);
  font-family: var(--font-ui);
}

.sa-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.sa-page {
  /* Full-pane admin surface — the table owns the width (the chat content-max
     measure would crush its flexible columns). */
  padding: var(--space-8) var(--space-6);
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}

.sa-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 48px;
  padding: 0 var(--space-6);
  border-bottom: 0.5px solid var(--color-line);
  box-sizing: border-box;
}
.sa-title {
  margin: 0;
  font-size: var(--text-base);
  font-weight: var(--weight-semibold);
  line-height: var(--leading-tight);
  color: var(--color-text);
  user-select: none;
}
.sa-subtitle {
  margin: 0 0 var(--space-3);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  color: var(--color-text-muted);
}

/* macOS desktop (hidden title bar): the page head doubles as a window-drag
   region, same pattern as ChatHeader; interactive children opt out. */
.session-admin.macos-desktop .sa-head {
  -webkit-app-region: drag;
}
.session-admin.macos-desktop .sa-head button,
.session-admin.macos-desktop .sa-head input {
  -webkit-app-region: no-drag;
}

/* Filter bar (query form: drafts apply via 查询/重置/Enter only) */
.sa-filters {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  margin-bottom: var(--space-3);
}
.sa-f-label {
  margin-left: var(--space-2);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  user-select: none;
}
.sa-f-label:first-child {
  margin-left: 0;
}
.sa-f-actions {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  margin-left: var(--space-2);
}
</style>
