<!-- apps/kimi-web/src/components/dialogs/NewWorktreeDialog.vue -->
<!-- Quick-create a git worktree: pick a workspace, optionally name the branch,
     then jump straight into a draft session in the new worktree. -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { WorkspaceView } from '../../types';

const { t } = useI18n();

const props = defineProps<{
  workspaces: WorkspaceView[];
  defaultWorkspaceId: string | null;
  createWorktree: (
    workspaceId: string,
    input?: { branch?: string },
  ) => Promise<{ path: string }>;
}>();

const emit = defineEmits<{
  created: [workspaceId: string, path: string];
  cancel: [];
}>();

const gitWorkspaces = computed(() =>
  props.workspaces
    .filter((w) => w.isGitRepo)
    .toSorted((a, b) => (b.sessionCount - a.sessionCount) || a.name.localeCompare(b.name)),
);
const workspaceId = ref<string | null>(null);
const branch = ref('');
const loading = ref(false);
const error = ref<string | null>(null);

watch(
  () => [props.defaultWorkspaceId, props.workspaces],
  () => {
    const list = gitWorkspaces.value;
    // Preserve a manual selection as long as it still points to a valid
    // workspace. `props.workspaces` recomputes continuously while a session is
    // running, so re-syncing on every change would clobber the user's pick and
    // pin the field back to the active session's workspace.
    if (workspaceId.value !== null && list.some((w) => w.id === workspaceId.value)) {
      return;
    }
    const def = props.defaultWorkspaceId;
    workspaceId.value =
      def !== null && list.some((w) => w.id === def) ? def : (list[0]?.id ?? null);
  },
  { immediate: true },
);

function onBackdrop(e: MouseEvent): void {
  if (e.target === e.currentTarget && !loading.value) emit('cancel');
}
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && !loading.value) emit('cancel');
}

async function onCreate(): Promise<void> {
  const wsId = workspaceId.value;
  if (!wsId || loading.value) return;
  loading.value = true;
  error.value = null;
  try {
    const name = branch.value.trim();
    const created = await props.createWorktree(wsId, name.length > 0 ? { branch: name } : undefined);
    emit('created', wsId, created.path);
  } catch (error_) {
    error.value = error_ instanceof Error ? error_.message : String(error_);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="backdrop" @mousedown="onBackdrop" @keydown="onKeydown" tabindex="-1">
    <div class="dialog" role="dialog" :aria-label="t('worktree.newTitle')">
      <div class="head">
        <span class="title">{{ t('worktree.newTitle') }}</span>
      </div>

      <div class="body">
        <div class="field">
          <span class="label">{{ t('worktree.newWorkspace') }}</span>
          <div class="ws-list">
            <button
              v-for="w in gitWorkspaces"
              :key="w.id"
              type="button"
              class="ws-row"
              :class="{ on: w.id === workspaceId }"
              :disabled="loading"
              @click="workspaceId = w.id"
            >
              <span class="ws-name">{{ w.name }}</span>
              <span v-if="w.sessionCount > 0" class="ws-count">{{ w.sessionCount }}</span>
              <span class="ws-path">{{ w.shortPath || w.root }}</span>
            </button>
            <div v-if="gitWorkspaces.length === 0" class="ws-empty">{{ t('worktree.noGitWorkspaces') }}</div>
          </div>
        </div>

        <label class="field">
          <span class="label">{{ t('worktree.branchPlaceholder') }}</span>
          <input
            v-model="branch"
            class="input"
            type="text"
            :placeholder="t('worktree.newBranchHint')"
            :disabled="loading"
            @keydown.enter="onCreate"
          />
        </label>

        <div v-if="error" class="err">{{ error }}</div>
      </div>

      <div class="foot">
        <button class="btn-ghost" :disabled="loading" @click="emit('cancel')">{{ t('worktree.cancel') }}</button>
        <button class="btn-primary" :disabled="loading || !workspaceId || gitWorkspaces.length === 0" @click="onCreate">
          {{ loading ? t('worktree.creating') : t('worktree.create') }}
        </button>
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
  padding-top: 14vh;
  z-index: 120;
  outline: none;
}
.dialog {
  width: min(560px, 92vw);
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.18);
  font-family: var(--mono);
  color: var(--ink);
  overflow: hidden;
}
.head { padding: 14px 16px; border-bottom: 1px solid var(--line); }
.title { font-size: var(--ui-font-size); font-weight: 600; }
.body { padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
.field { display: flex; flex-direction: column; gap: 6px; }
.label { font-size: var(--ui-font-size-xs); color: var(--muted); }
.ws-list {
  border: 1px solid var(--line);
  border-radius: 8px;
  max-height: 220px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.ws-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 11px;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--line);
  color: var(--text);
  font-family: var(--mono);
  text-align: left;
  cursor: pointer;
}
.ws-row:last-child { border-bottom: none; }
.ws-row:hover { background: var(--panel2); }
.ws-row.on {
  background: var(--soft);
  box-shadow: inset 0 0 0 1px var(--bd);
}
.ws-row:disabled { opacity: 0.6; cursor: default; }
.ws-name { color: var(--ink); font-weight: 500; font-size: var(--ui-font-size); flex: none; }
.ws-count {
  flex: none;
  font-size: var(--ui-font-size-xs);
  color: var(--faint);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 0 5px;
  line-height: 16px;
}
.ws-path {
  margin-left: auto;
  color: var(--faint);
  font-size: var(--ui-font-size-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.ws-empty { padding: 14px 11px; color: var(--faint); font-size: var(--ui-font-size-xs); }
.input {
  font-family: var(--mono);
  font-size: var(--ui-font-size);
  color: var(--ink);
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 6px 8px;
  outline: none;
  width: 100%;
}
.input:focus { border-color: var(--blue); }
.err { color: var(--err); font-size: var(--ui-font-size-xs); word-break: break-word; }
.foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--line);
}
.btn-ghost {
  background: none;
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--dim);
  font-family: var(--mono);
  font-size: var(--ui-font-size);
  padding: 6px 14px;
  cursor: pointer;
}
.btn-ghost:hover { color: var(--ink); background: var(--panel2); }
.btn-primary {
  background: var(--blue);
  color: #fff;
  border: none;
  border-radius: 6px;
  font-family: var(--mono);
  font-size: var(--ui-font-size);
  padding: 6px 14px;
  cursor: pointer;
}
.btn-primary:disabled { opacity: 0.6; cursor: default; }
.btn-primary:not(:disabled):hover { background: var(--blue2); }
</style>
