<!-- apps/kimi-web/src/components/WorktreeBoard.vue -->
<!-- Global worktree board: every worktree across all git workspaces is a
     column in an auto-filling grid, sorted so active worktrees come first.
     The repo is shown as a secondary label on each column (workspace is no
     longer a grouping level, matching the worktree-centric sidebar). -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppWorktree } from '../api/types';
import type { BoardSection, CompleteWorktreeTarget, Session, WorkspaceView } from '../types';
import { branchColor } from '../lib/branchColor';
import OpenInMenu from './chat/OpenInMenu.vue';

const { t } = useI18n();

const props = defineProps<{
  sections: BoardSection[];
  activeSessionId: string | null;
  pendingBySession: Record<string, { approvals: number; questions: number }>;
  unreadBySession: Record<string, boolean>;
  loading?: boolean;
  /** Installed external-app IDs from the daemon; forwarded to the open-in menu. */
  availableOpenInApps?: string[];
}>();

const emit = defineEmits<{
  back: [];
  selectSession: [sessionId: string];
  /** Open a (draft) session scoped to a worktree path in a workspace. */
  openWorktree: [workspaceId: string, path: string];
  openPr: [url: string];
  complete: [target: CompleteWorktreeTarget];
  openNewWorktree: [];
  /** Open a worktree folder in an external application. */
  openInApp: [workspaceId: string, path: string, appId: string];
}>();

interface FlatColumn {
  workspace: WorkspaceView;
  worktree: AppWorktree;
  sessions: Session[];
  hasRunning: boolean;
  hasPending: boolean;
  latestAt: number;
}

function columnsFor(section: BoardSection): { worktree: AppWorktree; sessions: Session[] }[] {
  const wts = [...section.worktrees].toSorted((a, b) => {
    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
    return a.branch.localeCompare(b.branch);
  });
  const used = new Set<string>();
  const cols: { worktree: AppWorktree; sessions: Session[] }[] = wts.map((worktree) => {
    const ss = section.sessions.filter((s) => {
      if (s.branch === worktree.branch) {
        used.add(s.id);
        return true;
      }
      return false;
    });
    return { worktree, sessions: ss };
  });
  // Unassigned sessions (branch not matched to any worktree) fall into main.
  const unassigned = section.sessions.filter((s) => !used.has(s.id));
  if (unassigned.length > 0) {
    const main = cols.find((c) => c.worktree.isMain);
    if (main) main.sessions = [...main.sessions, ...unassigned];
  }
  return cols;
}

const BUCKET_MS = 30_000;
const columns = computed<FlatColumn[]>(() => {
  const flat: FlatColumn[] = [];
  for (const section of props.sections) {
    for (const col of columnsFor(section)) {
      const sessions = [...col.sessions].toSorted(
        (a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime(),
      );
      const hasRunning = sessions.some((s) => s.busy);
      const hasPending = sessions.some(
        (s) => s.status === 'awaitingApproval' || s.status === 'awaitingQuestion',
      );
      const latestAt = sessions.reduce(
        (m, s) => Math.max(m, s.updatedAt ? new Date(s.updatedAt).getTime() : 0),
        0,
      );
      flat.push({
        workspace: section.workspace,
        worktree: col.worktree,
        sessions,
        hasRunning,
        hasPending,
        latestAt,
      });
    }
  }
  flat.sort((a, b) => {
    const aa = a.hasRunning || a.hasPending ? 1 : 0;
    const bb = b.hasRunning || b.hasPending ? 1 : 0;
    if (aa !== bb) return bb - aa;
    const ba = Math.floor(b.latestAt / BUCKET_MS);
    const bk = Math.floor(a.latestAt / BUCKET_MS);
    if (ba !== bk) return ba - bk;
    const ka = `${a.workspace.id}:${a.worktree.branch}`;
    const kb = `${b.workspace.id}:${b.worktree.branch}`;
    return ka.localeCompare(kb);
  });
  return flat;
});

function attention(col: FlatColumn): 'running' | 'pending' | null {
  if (col.hasRunning) return 'running';
  if (col.hasPending) return 'pending';
  return null;
}

function branchLabel(w: AppWorktree): string {
  if (w.branch.length > 0) return w.branch;
  if (w.head.length > 0) return w.head.slice(0, 7);
  return t('worktree.detached');
}

function completeTarget(col: FlatColumn): CompleteWorktreeTarget {
  return {
    workspaceId: col.workspace.id,
    path: col.worktree.path,
    branch: col.worktree.branch,
    dirty: col.worktree.dirty,
    sessionCount: col.sessions.length,
    isMain: col.worktree.isMain,
  };
}
</script>

<template>
  <div class="board">
    <div class="topbar">
      <button class="back" :title="t('worktree.close')" @click="emit('back')">‹</button>
      <span class="title">{{ t('worktree.boardTitle') }}</span>
      <span class="spacer" />
      <button class="btn-primary" @click="emit('openNewWorktree')">+ {{ t('worktree.create') }}</button>
    </div>

    <div v-if="loading" class="loading">{{ t('worktree.loading') }}</div>

    <div v-else class="grid">
      <div
        v-for="col in columns"
        :key="`${col.workspace.id}:${col.worktree.path}`"
        class="col"
        :style="col.worktree.branch ? { '--c': branchColor(col.worktree.branch) } : undefined"
      >
        <div class="col-head">
          <div class="col-label">
            <span class="br" :title="col.worktree.path">{{ branchLabel(col.worktree) }}</span>
            <span class="ws" :title="col.workspace.root">{{ col.workspace.name }}</span>
            <span v-if="col.worktree.isMain" class="badge">{{ t('worktree.main') }}</span>
          </div>
          <button
            v-if="col.worktree.pullRequest"
            class="pr"
            :class="`pr-${col.worktree.pullRequest.state}`"
            :title="col.worktree.pullRequest.url"
            @click.stop="col.worktree.pullRequest && emit('openPr', col.worktree.pullRequest.url)"
          >#{{ col.worktree.pullRequest.number }}</button>
          <span
            v-if="attention(col)"
            class="attn"
            :class="`attn-${attention(col)}`"
          />
          <span class="count">{{ col.sessions.length }}</span>
        </div>
        <div class="col-meta">
          <span v-if="col.worktree.dirty">{{ t('worktree.dirty') }}</span>
          <span v-if="col.worktree.ahead > 0">↑{{ col.worktree.ahead }}</span>
          <span v-if="col.worktree.behind > 0">↓{{ col.worktree.behind }}</span>
          <span v-if="!col.worktree.dirty && col.worktree.ahead === 0 && col.worktree.behind === 0">{{ t('worktree.clean') }}</span>
        </div>

        <div class="col-body">
          <div
            v-for="s in col.sessions"
            :key="s.id"
            class="sess-card"
            :class="{ on: s.id === activeSessionId }"
            @click="emit('selectSession', s.id)"
          >
            <div class="tline">
              <span v-if="s.busy" class="spin" />
              <span v-else-if="unreadBySession[s.id]" class="unread" />
              <span class="t">{{ s.title }}</span>
            </div>
            <div v-if="s.lastPrompt" class="preview">{{ s.lastPrompt }}</div>
            <div class="foot">
              <span class="time">{{ s.time }}</span>
              <span v-if="(pendingBySession[s.id]?.questions ?? 0) > 0 || s.status === 'awaitingQuestion'" class="tag tag-ask">{{ t('workspace.awaitingAnswer') }}</span>
              <span v-if="(pendingBySession[s.id]?.approvals ?? 0) > 0 || s.status === 'awaitingApproval'" class="tag tag-approve">{{ t('workspace.awaitingPermission') }}</span>
            </div>
          </div>
          <div v-if="col.sessions.length === 0" class="empty">{{ t('worktree.noSessions') }}</div>
        </div>

        <div class="col-foot">
          <button
            class="add"
            @click="emit('openWorktree', col.workspace.id, col.worktree.path)"
          >+ session</button>
          <OpenInMenu
            compact
            :work-dir="col.worktree.path"
            :available-apps="availableOpenInApps"
            @open-in-app="(appId) => emit('openInApp', col.workspace.id, col.worktree.path, appId)"
          />
          <button
            v-if="!col.worktree.isMain"
            class="del"
            @click="emit('complete', completeTarget(col))"
          >{{ t('worktree.complete') }}</button>
        </div>
      </div>

      <div v-if="columns.length === 0" class="empty-all">{{ t('worktree.noGitWorkspaces') }}</div>
    </div>
  </div>
</template>

<style scoped>
.board {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--panel);
  color: var(--text);
  font-family: var(--mono);
  overflow: hidden;
}
.topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--line);
  background: var(--bg);
  flex: none;
}
.back {
  background: none;
  border: 1px solid var(--line);
  border-radius: 7px;
  color: var(--dim);
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  width: 28px;
  height: 28px;
  flex: none;
}
.back:hover { color: var(--ink); background: var(--panel2); }
.title { font-size: 16px; font-weight: 600; color: var(--ink); }
.spacer { flex: 1; }
.btn-primary {
  background: var(--blue);
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 6px 12px;
  font-family: var(--mono);
  font-size: var(--ui-font-size);
  cursor: pointer;
  white-space: nowrap;
}
.btn-primary:hover { background: var(--blue2); }
.loading { padding: 40px; color: var(--faint); text-align: center; }
.empty-all { padding: 40px; color: var(--faint); text-align: center; grid-column: 1 / -1; }

.grid {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 18px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(290px, 1fr));
  gap: 14px;
  align-items: start;
  align-content: start;
}
.col {
  background: var(--bg);
  border: 1px solid var(--line);
  border-top: 3px solid var(--c, var(--line));
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  max-height: 60vh;
  box-shadow: 0 2px 10px rgba(20, 23, 28, 0.05);
}
.col-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 11px 13px 4px;
  min-width: 0;
  flex: none;
}
/* Left cluster (branch + workspace + badge): fills the column header so the
   branch name uses every pixel not taken by the PR / attention / count on the
   right — mirroring the sidebar group header. The workspace name is capped and
   shrinks first since the branch is the primary label. */
.col-label {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 1 1 auto;
  min-width: 0;
}
.br { color: var(--c, var(--dim)); font-weight: 600; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto; min-width: 0; }
.ws { color: var(--faint); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 0 1 auto; min-width: 0; max-width: 40%; }
.badge { font-size: 11px; color: var(--faint); border: 1px solid var(--line); border-radius: 8px; padding: 0 5px; flex: none; }
.pr {
  flex: none; border: 1px solid transparent; border-radius: 9px; padding: 0 6px; height: 18px; line-height: 16px;
  font-size: 12px; background: transparent; cursor: pointer; font-family: var(--mono);
}
.pr-open { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 38%, var(--bg)); }
.pr-merged { color: #8957e5; border-color: color-mix(in srgb, #8957e5 38%, var(--bg)); }
.attn { flex: none; width: 7px; height: 7px; border-radius: 50%; }
.attn-running { background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 18%, transparent); }
.attn-pending { background: var(--warn); box-shadow: 0 0 0 3px color-mix(in srgb, var(--warn) 18%, transparent); }
.count { color: var(--faint); font-size: 12px; flex: none; }
.col-meta { display: flex; gap: 8px; padding: 0 13px 8px; font-size: 11px; color: var(--muted); flex: none; }

.col-body { padding: 4px 9px 9px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; min-height: 0; }
.sess-card {
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 10px 11px;
  cursor: pointer;
  transition: border-color .12s, box-shadow .12s, transform .12s;
}
.sess-card:hover { border-color: var(--blue); box-shadow: 0 4px 12px rgba(20, 23, 28, 0.08); transform: translateY(-1px); }
.sess-card.on { border-color: var(--blue); box-shadow: inset 0 0 0 1px var(--bd); }
.tline { display: flex; align-items: center; gap: 6px; }
.t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink); font-weight: 500; font-size: 13px; }
.spin { width: 12px; height: 12px; border: 2px solid var(--line); border-top-color: var(--blue); border-radius: 50%; animation: sp .8s linear infinite; flex: none; }
@keyframes sp { to { transform: rotate(360deg); } }
.unread { width: 7px; height: 7px; border-radius: 50%; background: var(--blue); flex: none; }
.preview { color: var(--muted); font-size: 11px; margin-top: 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.foot { display: flex; align-items: center; gap: 6px; margin-top: 7px; }
.time { color: var(--faint); font-size: 11px; margin-right: auto; }
.tag { flex: none; height: 18px; border-radius: 9px; padding: 0 6px; line-height: 18px; font-size: 11px; border: 1px solid transparent; }
.tag-ask { background: var(--soft); color: var(--blue2); border-color: var(--bd); }
.tag-approve { background: color-mix(in srgb, var(--warn) 16%, var(--bg)); color: var(--warn); border-color: color-mix(in srgb, var(--warn) 38%, var(--bg)); }
.empty { color: var(--faint); font-size: 11px; text-align: center; padding: 14px 0; }

.col-foot { padding: 9px; border-top: 1px solid var(--line); flex: none; display: flex; gap: 6px; align-items: center; }
.add { flex: 1; text-align: center; color: var(--faint); font-size: 12px; padding: 6px; border: 1px dashed var(--line); border-radius: 8px; cursor: pointer; background: transparent; font-family: var(--mono); }
.add:hover { color: var(--blue); border-color: var(--blue); }
.del { background: none; border: none; color: var(--faint); cursor: pointer; font-family: var(--mono); font-size: 11px; padding: 4px 6px; border-radius: 6px; }
.del:hover { color: var(--err); background: var(--panel2); }
</style>
