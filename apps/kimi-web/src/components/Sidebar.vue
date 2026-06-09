<!-- apps/kimi-web/src/components/Sidebar.vue -->
<!-- Variant B left region: a narrow workspace rail + the session column, side -->
<!-- by side, inside one App.vue grid cell. The rail does workspace switching + -->
<!-- account; the column shows the active workspace's sessions (flat in -->
<!-- 'current' scope, grouped in 'all' scope). -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Session, WorkspaceGroup, WorkspaceScope, WorkspaceView } from '../types';
import type { Theme } from '../composables/useKimiWebClient';
import WorkspaceRail from './WorkspaceRail.vue';
import SessionRow from './SessionRow.vue';

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    workspaces: WorkspaceView[];
    activeWorkspace: WorkspaceView | null;
    activeWorkspaceId: string | null;
    scope: WorkspaceScope;
    sessions: Session[];
    groups: WorkspaceGroup[];
    activeId: string;
    attentionBySession?: Record<string, number>;
    attentionByWorkspace?: Record<string, number>;
    authReady?: boolean;
    accountModel?: string | null;
    /** Width (px) of the session column, driven by the App resize handle. */
    colWidth?: number;
    /** Whether the workspace rail is in its wide (named) mode. */
    railExpanded?: boolean;
    /** Active UI theme — forwarded to the rail's bottom-left toggle. */
    theme?: Theme;
  }>(),
  {
    activeWorkspace: null,
    activeWorkspaceId: null,
    attentionBySession: () => ({}),
    attentionByWorkspace: () => ({}),
    authReady: false,
    accountModel: null,
    colWidth: 196,
    railExpanded: false,
    theme: 'terminal',
  },
);

const emit = defineEmits<{
  select: [sessionId: string];
  create: [];
  createInWorkspace: [workspaceId: string];
  selectWorkspace: [workspaceId: string];
  setScope: [scope: WorkspaceScope];
  addWorkspace: [];
  rename: [id: string, title: string];
  delete: [id: string];
  login: [];
  logout: [];
  toggleRailExpand: [];
  setTheme: [theme: Theme];
}>();

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
const searchQuery = ref('');

function matchQuery(list: Session[]): Session[] {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return list;
  return list.filter((s) => s.title.toLowerCase().includes(q));
}

const filteredSessions = computed(() => matchQuery(props.sessions));

const filteredGroups = computed<WorkspaceGroup[]>(() =>
  props.groups
    .map((g) => ({ workspace: g.workspace, sessions: matchQuery(g.sessions) }))
    .filter((g) => g.sessions.length > 0),
);

const totalSessionCount = computed(() => props.sessions.length);

// ---------------------------------------------------------------------------
// Column header: read-only active-workspace name + branch + scope toggle
// ---------------------------------------------------------------------------
const isAllScope = computed(() => props.scope === 'all');

function toggleScope(): void {
  emit('setScope', isAllScope.value ? 'current' : 'all');
}

const railRef = ref<InstanceType<typeof WorkspaceRail> | null>(null);

function closeMenus(): void {
  railRef.value?.close();
}
</script>

<template>
  <!-- clicking anywhere outside the rail popover closes it -->
  <aside class="side" @click="closeMenus">
    <WorkspaceRail
      ref="railRef"
      :workspaces="workspaces"
      :active-id="activeWorkspaceId"
      :attention-by-workspace="attentionByWorkspace"
      :auth-ready="authReady"
      :account-model="accountModel"
      :expanded="railExpanded"
      :theme="theme"
      @select="emit('selectWorkspace', $event)"
      @add-workspace="emit('addWorkspace')"
      @login="emit('login')"
      @logout="emit('logout')"
      @toggle-expand="emit('toggleRailExpand')"
      @set-theme="emit('setTheme', $event)"
    />

    <!-- Session column -->
    <div class="col" :style="{ width: colWidth + 'px' }">
      <!-- Column header: active workspace name + branch (read-only) + scope + New -->
      <div class="ch">
        <div class="ch-ws">
          <span class="ch-name" :title="activeWorkspace ? activeWorkspace.root : ''">
            {{ activeWorkspace ? activeWorkspace.name : t('workspace.noWorkspace') }}
          </span>
          <span v-if="activeWorkspace && activeWorkspace.branch" class="ch-branch">{{ activeWorkspace.branch }}</span>
        </div>
        <button
          type="button"
          class="ch-scope"
          :class="{ on: isAllScope }"
          :title="isAllScope ? t('workspace.currentWorkspace') : t('workspace.allWorkspaces')"
          @click.stop="toggleScope"
        >
          {{ isAllScope ? t('workspace.scopeAll') : t('workspace.scopeCurrent') }}
        </button>
      </div>

      <div class="sh">
        {{ t('sidebar.sessionsHeader') }}
        <span class="new" @click.stop="emit('create')">{{ t('sidebar.newSession') }}</span>
      </div>

      <!-- Search box -->
      <div class="search-wrap">
        <input
          v-model="searchQuery"
          class="search-input"
          :placeholder="t('sidebar.searchPlaceholder')"
          type="text"
          @click.stop
        />
      </div>

      <!-- Session list -->
      <div class="sessions">
        <!-- Empty state -->
        <div v-if="totalSessionCount === 0" class="empty">
          {{ t('sidebar.emptyState') }}
        </div>

        <!-- 'all' scope: per-workspace collapsible groups -->
        <template v-else-if="scope === 'all'">
          <div v-for="g in filteredGroups" :key="g.workspace.id" class="group">
            <div class="gh">
              <span class="gh-name">{{ g.workspace.name }}</span>
              <span class="gh-path" :title="g.workspace.root">{{ g.workspace.shortPath }}</span>
              <span class="gh-count">{{ g.sessions.length }}</span>
              <button
                class="gh-add"
                :title="t('workspace.newInGroup')"
                @click.stop="emit('createInWorkspace', g.workspace.id)"
              >+</button>
            </div>
            <div class="group-sessions">
              <SessionRow
                v-for="s in g.sessions"
                :key="s.id"
                :session="s"
                :active="s.id === activeId"
                :attention="attentionBySession[s.id] ?? 0"
                @select="emit('select', $event)"
                @rename="(id, title) => emit('rename', id, title)"
                @delete="emit('delete', $event)"
              />
            </div>
          </div>
          <div v-if="filteredGroups.length === 0" class="empty">
            {{ t('sidebar.noMatches') }}
          </div>
        </template>

        <!-- 'current' scope: flat list of the active workspace's sessions -->
        <template v-else>
          <SessionRow
            v-for="s in filteredSessions"
            :key="s.id"
            :session="s"
            :active="s.id === activeId"
            :attention="attentionBySession[s.id] ?? 0"
            @select="emit('select', $event)"
            @rename="(id, title) => emit('rename', id, title)"
            @delete="emit('delete', $event)"
          />
          <div v-if="filteredSessions.length === 0" class="empty">
            {{ t('sidebar.noMatches') }}
          </div>
        </template>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.side {
  border-right: 1px solid var(--line);
  background: var(--panel);
  display: flex;
  flex-direction: row;
  min-width: 0;
  height: 100%;
}

/* Session column (everything right of the rail). Width is set inline from the
   App resize handle; flex: none so that explicit width wins. */
.col {
  flex: none;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

/* Column header: read-only active workspace + scope toggle */
.ch {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px 8px;
  border-bottom: 1px solid var(--line);
}
.ch-ws {
  display: flex;
  align-items: baseline;
  gap: 7px;
  min-width: 0;
  flex: 1;
}
.ch-name {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ch-branch {
  font-size: 10.5px;
  color: var(--muted);
  flex: none;
}
.ch-scope {
  flex: none;
  border: 1px solid var(--line);
  background: none;
  font: inherit;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--muted);
  cursor: pointer;
  padding: 2px 7px;
  border-radius: 9px;
  white-space: nowrap;
}
.ch-scope:hover { color: var(--ink); border-color: var(--bd); }
.ch-scope.on {
  color: var(--blue2);
  border-color: var(--bd);
  background: var(--soft);
}

.sh {
  padding: 9px 12px 6px;
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: var(--muted);
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.new { color: var(--blue2); cursor: pointer; text-transform: none; letter-spacing: 0; font-size: 11px; }
.new:hover { text-decoration: underline; }

/* Search */
.search-wrap { padding: 0 10px 6px; }
.search-input {
  width: 100%;
  box-sizing: border-box;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink);
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 3px;
  padding: 4px 7px;
  outline: none;
  transition: border-color 0.15s;
}
.search-input:focus { border-color: var(--blue); }
.search-input::placeholder { color: var(--faint); }

/* Sessions */
.sessions { flex: 1; overflow-y: auto; padding: 0 0 8px; min-height: 0; }

.empty {
  padding: 24px 12px;
  text-align: center;
  color: var(--faint);
  font-size: 11px;
  line-height: 1.6;
}

/* Workspace group (all-workspaces scope) — reuses the .sh header look */
.group { padding-bottom: 2px; }
.gh {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 8px 12px 4px;
  font-size: 10.5px;
}
.gh-name {
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: var(--muted);
  font-weight: 600;
  flex: none;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gh-path {
  color: var(--faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 1;
}
.gh-count { color: var(--faint); flex: none; }
.gh-add {
  background: none;
  border: none;
  color: var(--blue2);
  cursor: pointer;
  font-family: var(--mono);
  font-size: 13px;
  line-height: 1;
  padding: 0 2px;
  flex: none;
}
.gh-add:hover { color: var(--blue); }
.group-sessions :deep(.se) { padding-left: 18px; }
</style>
