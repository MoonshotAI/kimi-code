<!-- apps/kimi-web/src/components/dialogs/WorktreeCompleteDialog.vue -->
<!-- Confirmation modal for "completing" a worktree: the daemon deletes the
     worktree directory (git worktree remove), so this confirms a destructive
     action and optionally deletes the branch too. -->
<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { CompleteWorktreeTarget } from '../../types';

const { t } = useI18n();

const props = defineProps<{
  target: CompleteWorktreeTarget | null;
  removeWorktree: (
    workspaceId: string,
    input: { path: string; force?: boolean; deleteBranch?: boolean },
  ) => Promise<void>;
}>();

const emit = defineEmits<{
  cancel: [];
}>();

const deleteBranch = ref(false);
const loading = ref(false);
const error = ref<string | null>(null);

// Reset state whenever the target changes.
watch(
  () => props.target?.path,
  () => {
    deleteBranch.value = false;
    loading.value = false;
    error.value = null;
  },
);

function onBackdrop(e: MouseEvent): void {
  if (e.target === e.currentTarget && !loading.value) emit('cancel');
}
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && !loading.value) emit('cancel');
}

async function onConfirm(): Promise<void> {
  const target = props.target;
  if (!target || loading.value) return;
  loading.value = true;
  error.value = null;
  try {
    await props.removeWorktree(target.workspaceId, {
      path: target.path,
      force: target.dirty,
      deleteBranch: deleteBranch.value,
    });
    emit('cancel');
  } catch (error_) {
    error.value = error_ instanceof Error ? error_.message : String(error_);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div
    v-if="target"
    class="backdrop"
    @mousedown="onBackdrop"
    @keydown="onKeydown"
    tabindex="-1"
  >
    <div class="dialog" role="dialog" :aria-label="t('worktree.completeTitle')">
      <div class="head">
        <span class="title">{{ t('worktree.completeTitle', { branch: target.branch || target.path }) }}</span>
      </div>

      <div class="body">
        <p class="lead">{{ t('worktree.completeLead') }}</p>
        <div class="path" :title="target.path">{{ target.path }}</div>

        <div v-if="target.dirty" class="warn">
          {{ t('worktree.completeDirty') }}
        </div>
        <div v-if="target.sessionCount > 0" class="note">
          {{ t('worktree.completeSessions', { count: target.sessionCount }) }}
        </div>

        <label class="check">
          <input v-model="deleteBranch" type="checkbox" :disabled="loading" />
          <span>{{ t('worktree.completeDeleteBranch', { branch: target.branch }) }}</span>
        </label>

        <div v-if="error" class="err">{{ error }}</div>
      </div>

      <div class="foot">
        <button class="btn-ghost" :disabled="loading" @click="emit('cancel')">{{ t('worktree.cancel') }}</button>
        <button class="btn-danger" :disabled="loading" @click="onConfirm">
          {{ loading ? t('worktree.completing') : t('worktree.completeConfirm') }}
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
  width: min(460px, 92vw);
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.18);
  font-family: var(--mono);
  color: var(--ink);
  overflow: hidden;
}
.head {
  padding: 14px 16px;
  border-bottom: 1px solid var(--line);
}
.title { font-size: var(--ui-font-size); font-weight: 600; }
.body { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.lead { margin: 0; color: var(--text); font-size: var(--ui-font-size); }
.path {
  font-size: var(--ui-font-size-xs);
  color: var(--dim);
  background: var(--panel2);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 6px 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.warn {
  color: var(--warn);
  font-size: var(--ui-font-size-xs);
  background: color-mix(in srgb, var(--warn) 10%, var(--bg));
  border: 1px solid color-mix(in srgb, var(--warn) 30%, var(--bg));
  border-radius: 6px;
  padding: 6px 8px;
}
.note { color: var(--muted); font-size: var(--ui-font-size-xs); }
.err { color: var(--err); font-size: var(--ui-font-size-xs); word-break: break-word; }
.check {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: var(--ui-font-size-xs);
  color: var(--text);
  cursor: pointer;
  margin-top: 2px;
}
.check input { margin: 0; }
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
.btn-danger {
  background: var(--err);
  color: #fff;
  border: none;
  border-radius: 6px;
  font-family: var(--mono);
  font-size: var(--ui-font-size);
  padding: 6px 14px;
  cursor: pointer;
}
.btn-danger:hover { opacity: 0.9; }
</style>
