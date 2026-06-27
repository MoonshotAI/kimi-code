<!-- apps/kimi-web/src/components/dialogs/WorktreeDialog.vue -->
<!-- Manage git worktrees of a workspace: list, create, and remove worktrees, -->
<!-- and jump into a session bound to each one. The parent owns the actual -->
<!-- daemon calls + navigation; this dialog renders state and emits intents. -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppWorktree } from '../../api/types';
import type { Session, WorkspaceView } from '../../types';
import { branchColor } from '../../lib/branchColor';

const { t } = useI18n();

const props = defineProps<{
  workspace: WorkspaceView;
  worktrees: AppWorktree[];
  /** Sessions belonging to this workspace, used to resolve linked-session titles. */
  sessions: Session[];
  createWorktree: (
    workspaceId: string,
    input?: { branch?: string; baseRef?: string; path?: string },
  ) => Promise<AppWorktree>;
  removeWorktree: (
    workspaceId: string,
    input: { path: string; force?: boolean; deleteBranch?: boolean },
  ) => Promise<void>;
}>();

const emit = defineEmits<{
  close: [];
  /** Open a (draft) session scoped to the given worktree path. */
  openWorktree: [path: string];
  /** Select an already-linked session. */
  selectSession: [sessionId: string];
  /** Open a PR URL (handled by the parent, consistent with ChatHeader). */
  openPr: [url: string];
}>();

const branch = ref('');
const creating = ref(false);
const error = ref<string | null>(null);
// Per-row remove state: path → 'confirming' (first click) | 'busy'.
const removing = ref<Record<string, 'confirming' | 'busy'>>({});

const sessionById = computed(() => {
  const m = new Map<string, Session>();
  for (const s of props.sessions) m.set(s.id, s);
  return m;
});

const sorted = computed<AppWorktree[]>(() =>
  [...props.worktrees].toSorted((a, b) => {
    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
    return a.branch.localeCompare(b.branch);
  }),
);

const secondary = computed(() => sorted.value.filter((w) => !w.isMain));

function branchLabel(w: AppWorktree): string {
  if (w.branch.length > 0) return w.branch;
  if (w.head.length > 0) return w.head.slice(0, 7);
  return t('worktree.detached');
}

function sessionTitle(sessionId: string | null): string | null {
  if (sessionId === null) return null;
  return sessionById.value.get(sessionId)?.title ?? null;
}

async function onCreate(): Promise<void> {
  if (creating.value) return;
  creating.value = true;
  error.value = null;
  try {
    const name = branch.value.trim();
    const created = await props.createWorktree(
      props.workspace.id,
      name.length > 0 ? { branch: name } : undefined,
    );
    branch.value = '';
    emit('openWorktree', created.path);
  } catch (error_) {
    error.value = error_ instanceof Error ? error_.message : String(error_);
  } finally {
    creating.value = false;
  }
}

async function onRemove(w: AppWorktree): Promise<void> {
  const state = removing.value[w.path];
  // First click asks for confirmation, especially when dirty or linked.
  if (state !== 'confirming') {
    removing.value = { ...removing.value, [w.path]: 'confirming' };
    return;
  }
  removing.value = { ...removing.value, [w.path]: 'busy' };
  error.value = null;
  try {
    await props.removeWorktree(props.workspace.id, { path: w.path, force: w.dirty });
    const next = { ...removing.value };
    delete next[w.path];
    removing.value = next;
  } catch (error_) {
    error.value = error_ instanceof Error ? error_.message : String(error_);
    removing.value = { ...removing.value, [w.path]: 'confirming' };
  }
}

function cancelRemove(path: string): void {
  const next = { ...removing.value };
  delete next[path];
  removing.value = next;
}
</script>

<template>
  <div class="backdrop" @click.self="emit('close')">
    <div class="dialog" role="dialog" :aria-label="t('worktree.title')">
      <div class="head">
        <span class="title">{{ t('worktree.title') }}</span>
        <span class="sub">{{ workspace.name }}</span>
        <button class="x" :title="t('worktree.close')" @click="emit('close')">×</button>
      </div>

      <!-- Create -->
      <div class="create">
        <input
          v-model="branch"
          class="branch-input"
          type="text"
          :placeholder="t('worktree.branchPlaceholder')"
          :disabled="creating"
          @keydown.enter="onCreate"
        />
        <button class="btn-primary" :disabled="creating" @click="onCreate">
          {{ creating ? t('worktree.creating') : t('worktree.create') }}
        </button>
      </div>
      <div class="hint">{{ t('worktree.createHint') }}</div>

      <div v-if="error" class="err">{{ error }}</div>

      <!-- List -->
      <div class="list">
        <div v-if="sorted.length === 0" class="empty">{{ t('worktree.empty') }}</div>

        <div
          v-for="w in sorted"
          :key="w.path"
          class="row"
          :class="{ main: w.isMain }"
        >
          <div class="row-top">
            <span
              class="br-dot"
              :style="{ background: branchColor(branchLabel(w)) }"
              :title="w.path"
            />
            <span class="br" :title="w.path">{{ branchLabel(w) }}</span>
            <span v-if="w.isMain" class="badge">{{ t('worktree.main') }}</span>
            <span
              v-if="w.dirty"
              class="badge badge-dirty"
              :title="t('worktree.dirtyTitle')"
            >{{ t('worktree.dirty') }}</span>
            <span v-if="w.ahead > 0" class="delta">↑{{ w.ahead }}</span>
            <span v-if="w.behind > 0" class="delta">↓{{ w.behind }}</span>

            <button
              v-if="w.pullRequest"
              class="pr"
              :class="`pr-${w.pullRequest.state}`"
              :title="w.pullRequest.url"
              @click="emit('openPr', w.pullRequest.url)"
            >#{{ w.pullRequest.number }}</button>

            <span class="spacer" />

            <!-- Actions -->
            <template v-if="removing[w.path] === 'confirming'">
              <span class="confirm-label">{{ t('worktree.removeConfirm') }}</span>
              <button class="btn-danger" @click="onRemove(w)">{{ t('worktree.confirm') }}</button>
              <button class="btn-ghost" @click="cancelRemove(w.path)">{{ t('worktree.cancel') }}</button>
            </template>
            <template v-else>
              <button
                v-if="w.sessionId"
                class="btn-ghost"
                :title="sessionTitle(w.sessionId) ?? ''"
                @click="emit('selectSession', w.sessionId!)"
              >{{ t('worktree.openSession') }}</button>
              <button
                v-else-if="!w.isMain"
                class="btn-ghost"
                @click="emit('openWorktree', w.path)"
              >{{ t('worktree.newSessionHere') }}</button>
              <button
                v-if="!w.isMain"
                class="btn-ghost btn-del"
                :disabled="removing[w.path] === 'busy'"
                @click="onRemove(w)"
              >{{ t('worktree.remove') }}</button>
            </template>
          </div>

          <div v-if="sessionTitle(w.sessionId)" class="row-sub">
            {{ t('worktree.linkedTo') }}: {{ sessionTitle(w.sessionId) }}
          </div>
        </div>
      </div>

      <div v-if="secondary.length === 0 && sorted.length > 0" class="foot">
        {{ t('worktree.onlyMain') }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.32);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 8vh;
  z-index: 100;
}
.dialog {
  width: min(620px, 92vw);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.18);
  font-family: var(--mono);
  color: var(--ink);
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--line);
}
.title {
  font-size: var(--ui-font-size);
  font-weight: 600;
}
.sub {
  color: var(--faint);
  font-size: var(--ui-font-size-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.x {
  margin-left: auto;
  background: none;
  border: none;
  color: var(--muted);
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  padding: 2px 6px;
  border-radius: 4px;
}
.x:hover { color: var(--ink); background: var(--panel2); }

.create {
  display: flex;
  gap: 8px;
  padding: 12px 14px 4px;
}
.branch-input {
  flex: 1;
  min-width: 0;
  font-family: var(--mono);
  font-size: var(--ui-font-size);
  color: var(--ink);
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 5px 8px;
  outline: none;
}
.branch-input:focus { border-color: var(--blue); }
.btn-primary {
  background: var(--blue);
  color: #fff;
  border: none;
  border-radius: 4px;
  padding: 5px 12px;
  font-family: var(--mono);
  font-size: var(--ui-font-size);
  cursor: pointer;
  white-space: nowrap;
}
.btn-primary:disabled { opacity: 0.6; cursor: default; }
.btn-primary:not(:disabled):hover { opacity: 0.9; }

.hint {
  padding: 2px 14px 8px;
  color: var(--faint);
  font-size: var(--ui-font-size-xs);
}
.err {
  margin: 0 14px 8px;
  color: var(--err);
  font-size: var(--ui-font-size-xs);
  word-break: break-word;
}

.list {
  overflow-y: auto;
  padding: 4px 14px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.empty {
  color: var(--faint);
  font-size: var(--ui-font-size-xs);
  padding: 12px 0;
}
.row {
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 7px 9px;
}
.row.main { background: var(--soft); }
.row-top {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.br-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.br {
  font-size: var(--ui-font-size);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 38%;
}
.badge {
  flex: none;
  font-size: var(--ui-font-size-xs);
  color: var(--muted);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 0 6px;
  line-height: 16px;
}
.badge-dirty {
  color: var(--warn);
  border-color: color-mix(in srgb, var(--warn) 38%, var(--bg));
}
.delta {
  flex: none;
  color: var(--faint);
  font-size: var(--ui-font-size-xs);
}
.pr {
  flex: none;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 0 6px;
  line-height: 16px;
  font-family: var(--mono);
  font-size: var(--ui-font-size-xs);
  cursor: pointer;
  background: transparent;
}
.pr-open { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 38%, var(--bg)); }
.pr-merged { color: #8957e5; border-color: color-mix(in srgb, #8957e5 38%, var(--bg)); }
.pr-closed { color: var(--err); border-color: color-mix(in srgb, var(--err) 38%, var(--bg)); }
.spacer { flex: 1; }

.btn-ghost {
  flex: none;
  background: none;
  border: 1px solid var(--line);
  border-radius: 4px;
  color: var(--dim);
  font-family: var(--mono);
  font-size: var(--ui-font-size-xs);
  padding: 2px 8px;
  cursor: pointer;
  white-space: nowrap;
}
.btn-ghost:hover { color: var(--ink); background: var(--panel2); }
.btn-ghost:disabled { opacity: 0.6; cursor: default; }
.btn-del:hover { color: var(--err); }
.btn-danger {
  flex: none;
  background: var(--err);
  color: var(--bg);
  border: none;
  border-radius: 4px;
  font-family: var(--mono);
  font-size: var(--ui-font-size-xs);
  padding: 2px 8px;
  cursor: pointer;
}
.confirm-label {
  color: var(--err);
  font-size: var(--ui-font-size-xs);
}
.row-sub {
  margin-top: 4px;
  color: var(--faint);
  font-size: var(--ui-font-size-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.foot {
  padding: 0 14px 12px;
  color: var(--faint);
  font-size: var(--ui-font-size-xs);
}
</style>
