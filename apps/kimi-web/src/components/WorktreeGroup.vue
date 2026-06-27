<!-- apps/kimi-web/src/components/WorktreeGroup.vue -->
<!-- One worktree group in the worktree-centric sidebar: a header (branch +
     repo + PR + live indicator) and that worktree's session rows (with
     show-more truncation). Read-only header — management lives in the board. -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { CompleteWorktreeTarget, Session, WorktreeGroup } from '../types';
import SessionRow from './SessionRow.vue';
import OpenInMenu from './chat/OpenInMenu.vue';
import { branchColor } from '../lib/branchColor';

const { t } = useI18n();

const props = defineProps<{
  group: WorktreeGroup;
  activeId: string;
  pendingBySession: Record<string, { approvals: number; questions: number }>;
  unreadBySession: Record<string, boolean>;
  isCollapsed: boolean;
  isExpanded: boolean;
  visibleSessions: (sessions: Session[], expanded: boolean, activeId?: string) => Session[];
  /** Installed external-app IDs from the daemon; forwarded to the open-in menu. */
  availableOpenInApps?: string[];
}>();

const emit = defineEmits<{
  selectSession: [id: string];
  renameSession: [id: string, title: string];
  archiveSession: [id: string];
  forkSession: [id: string];
  openPr: [url: string];
  /** Open a draft session scoped to this worktree's checkout path. */
  newSession: [workspaceId: string, path: string];
  complete: [target: CompleteWorktreeTarget];
  toggleCollapse: [key: string];
  toggleExpand: [key: string];
  /** Open this worktree folder in an external application. */
  openInApp: [workspaceId: string, path: string, appId: string];
}>();

function completeTarget(): CompleteWorktreeTarget {
  return {
    workspaceId: props.group.workspaceId,
    path: props.group.path,
    branch: props.group.branch,
    dirty: props.group.dirty,
    sessionCount: props.group.sessions.length,
    isMain: props.group.isMain,
  };
}

const rows = computed<Session[]>(() =>
  props.visibleSessions(props.group.sessions, props.isExpanded, props.activeId),
);
const hasMore = computed(
  () =>
    !props.isExpanded &&
    props.visibleSessions(props.group.sessions, false, props.activeId).length <
      props.group.sessions.length,
);
const moreCount = computed(
  () =>
    props.group.sessions.length -
    props.visibleSessions(props.group.sessions, false, props.activeId).length,
);

// Color key: branch when known, otherwise the repo name (so the dot still has a stable color).
const colorKey = computed(() => props.group.branch || props.group.workspaceName);
// Group-level attention: running wins, otherwise awaiting-input, otherwise none.
const attention = computed<'running' | 'pending' | null>(() => {
  if (props.group.hasRunning) return 'running';
  if (props.group.hasPending) return 'pending';
  return null;
});
</script>

<template>
  <div class="wg" :class="{ 'is-empty': group.sessions.length === 0 }" :style="{ '--c': branchColor(colorKey) }">
    <div class="wg-head" @click="emit('toggleCollapse', group.key)">
      <div class="wg-label">
        <span class="repo" :title="group.workspaceName">{{ group.workspaceName }}</span>
        <template v-if="group.branch">
          <span class="sep">›</span>
          <span class="br" :title="group.branch">{{ group.branch }}</span>
        </template>
        <span v-if="group.isMain" class="badge">{{ t('worktree.main') }}</span>
      </div>
      <button
        v-if="group.pullRequest"
        class="pr"
        :class="`pr-${group.pullRequest.state}`"
        :title="group.pullRequest.url"
        @click.stop="group.pullRequest && emit('openPr', group.pullRequest.url)"
      >#{{ group.pullRequest.number }}</button>
      <button
        class="new-session-btn"
        :title="t('worktree.newSessionHere')"
        :aria-label="t('worktree.newSessionHere')"
        @click.stop="emit('newSession', group.workspaceId, group.path)"
      >+ session</button>
      <button
        v-if="!group.isMain"
        class="complete-btn"
        :title="t('worktree.complete')"
        @click.stop="emit('complete', completeTarget())"
      >{{ t('worktree.complete') }}</button>
      <span class="open-in-wrap" @click.stop>
        <OpenInMenu
          compact
          :work-dir="group.path"
          :available-apps="availableOpenInApps"
          @open-in-app="(appId) => emit('openInApp', group.workspaceId, group.path, appId)"
        />
      </span>
      <span
        v-if="attention"
        class="attn"
        :class="`attn-${attention}`"
        :title="attention === 'running' ? t('worktree.live') : t('worktree.pending')"
      />
    </div>

    <template v-if="!isCollapsed">
      <SessionRow
        v-for="s in rows"
        :key="s.id"
        :session="s"
        :active="s.id === activeId"
        :approval-count="pendingBySession[s.id]?.approvals ?? 0"
        :question-count="pendingBySession[s.id]?.questions ?? 0"
        :unread="unreadBySession[s.id] ?? false"
        @select="emit('selectSession', $event)"
        @rename="(id, title) => emit('renameSession', id, title)"
        @archive="emit('archiveSession', $event)"
        @fork="emit('forkSession', $event)"
      />

      <button v-if="hasMore" class="show-more" @click.stop="emit('toggleExpand', group.key)">
        {{ t('sidebar.showMore', { count: moreCount }) }}
      </button>
    </template>
  </div>
</template>

<style scoped>
.wg { padding: 4px 0; }
.wg + .wg { border-top: 1px solid var(--line); }
.wg-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px var(--sb-pad-x, 12px) 4px;
  min-width: 0;
  cursor: pointer;
}
.wg-head:hover { background: var(--panel2); }
/* Left cluster (repo › branch [badge]): grows to fill the header so the branch
   can use every pixel not taken by the right-side buttons — keeping branch
   names as fully visible as the sidebar width allows. The repo name is capped
   and shrinks first, since the branch is the key label in this view. */
.wg-label {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 1 1 auto;
  min-width: 0;
}
.repo {
  flex: 0 1 auto;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink);
  font-weight: 500;
  font-size: var(--ui-font-size-sm);
  font-family: var(--mono);
}
.sep {
  flex: none;
  color: var(--faint);
  font-size: var(--ui-font-size-sm);
}
.br {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--c);
  font-weight: 600;
  font-size: var(--ui-font-size-sm);
  font-family: var(--mono);
}
.badge {
  flex: none;
  font-size: var(--ui-font-size-xs);
  color: var(--faint);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 0 5px;
  line-height: 14px;
}
.attn {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.attn-running {
  background: var(--ok);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 18%, transparent);
}
.attn-pending {
  background: var(--warn);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--warn) 18%, transparent);
}
.complete-btn {
  display: none;
  flex: none;
  background: none;
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--muted);
  font-family: var(--mono);
  font-size: var(--ui-font-size-xs);
  padding: 0 7px;
  line-height: 14px;
  cursor: pointer;
}
.wg-head:hover .complete-btn { display: inline-flex; }
.complete-btn:hover { color: var(--err); border-color: var(--err); }
.new-session-btn {
  display: none;
  flex: none;
  background: none;
  border: 1px dashed var(--line);
  border-radius: 6px;
  color: var(--muted);
  font-family: var(--mono);
  font-size: var(--ui-font-size-xs);
  padding: 0 7px;
  line-height: 14px;
  cursor: pointer;
}
/* Show on hover for populated groups; always show for empty worktrees so a
   freshly-created checkout advertises how to start a session in it. */
.wg-head:hover .new-session-btn,
.wg.is-empty .new-session-btn { display: inline-flex; }
.new-session-btn:hover { color: var(--blue); border-color: var(--blue); }
.open-in-wrap {
  display: none;
  flex: none;
  align-items: center;
}
.wg-head:hover .open-in-wrap,
.wg.is-empty .open-in-wrap { display: inline-flex; }
.pr {
  flex: none;
  border: 1px solid transparent;
  border-radius: 9px;
  padding: 0 6px;
  height: 18px;
  line-height: 16px;
  font-size: 12px;
  background: transparent;
  cursor: pointer;
  font-family: var(--mono);
}
.pr-open { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 38%, var(--bg)); }
.pr-merged { color: #8957e5; border-color: color-mix(in srgb, #8957e5 38%, var(--bg)); }
.pr-closed { color: var(--err); border-color: color-mix(in srgb, var(--err) 38%, var(--bg)); }

.show-more {
  display: block;
  width: 100%;
  padding: 5px 10px 6px calc(var(--sb-pad-x, 12px) + 30px);
  background: none;
  border: none;
  color: var(--dim);
  font-size: calc(var(--ui-font-size) - 1.5px);
  font-family: var(--mono);
  cursor: pointer;
  text-align: left;
}
.show-more:hover { color: var(--blue2); background: var(--soft); }
</style>
