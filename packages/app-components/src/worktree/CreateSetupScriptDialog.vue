<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { newSessionEnvironmentStore } from '@moonshot-ai/app-client/stores';
import { Button, Dialog, Textarea } from '@moonshot-ai/app-ui';

const props = defineProps<{
  open: boolean;
  workspaceId?: string | null;
  workspaceName?: string;
}>();

const emit = defineEmits<{
  'update:open': [value: boolean];
  saved: [];
}>();

const DEFAULT_SCRIPT_PATH = '.kimi/setup.sh';

const { t } = useI18n();
const store = newSessionEnvironmentStore();

const content = ref('');
const saving = ref(false);
const failed = ref(false);

const script = computed(() => store.setupScript(props.workspaceId));
const scriptPath = computed(() => script.value?.path || DEFAULT_SCRIPT_PATH);
const errorText = computed(() =>
  failed.value ? (store.setupScriptError(props.workspaceId) ?? t('worktreeCreate.script.saveFailed')) : '',
);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    content.value = script.value?.content ?? '';
    saving.value = false;
    failed.value = false;
  },
  { immediate: true },
);

function close(): void {
  if (saving.value) return;
  emit('update:open', false);
}

async function save(): Promise<void> {
  const workspaceId = props.workspaceId;
  if (workspaceId === undefined || workspaceId === null || saving.value) return;
  saving.value = true;
  failed.value = false;
  const ok = await store.saveSetupScript(workspaceId, content.value);
  saving.value = false;
  if (!ok) {
    failed.value = true;
    return;
  }
  emit('saved');
  emit('update:open', false);
}
</script>

<template>
  <Dialog
    :open="open"
    :title="t('worktreeCreate.script.dialogTitle')"
    size="md"
    initial-focus="textarea"
    :close-on-overlay="!saving"
    :close-on-esc="!saving"
    @update:open="(value) => value || close()"
  >
    <div class="wss" data-worktree-setup-script>
      <div v-if="workspaceName" class="wss-project">{{ workspaceName }}</div>
      <p class="wss-desc">{{ t('worktreeCreate.script.dialogDescription') }}</p>
      <Textarea
        v-model="content"
        class="wss-editor"
        :rows="8"
        :placeholder="t('worktreeCreate.script.editorPlaceholder')"
        :disabled="saving"
        :error="failed"
        :aria-label="t('worktreeCreate.script.editorLabel')"
        spellcheck="false"
        autocapitalize="off"
        autocomplete="off"
      />
      <p class="wss-note">{{ t('worktreeCreate.script.savedTo', { path: scriptPath }) }}</p>
      <p v-if="errorText" class="wss-error" role="alert">{{ errorText }}</p>
    </div>
    <template #foot>
      <Button variant="secondary" :disabled="saving" data-action="cancel" @click="close">
        {{ t('worktreeCreate.script.cancel') }}
      </Button>
      <Button variant="primary" :loading="saving" data-action="save" @click="save">
        {{ t('worktreeCreate.script.save') }}
      </Button>
    </template>
  </Dialog>
</template>

<style scoped>
.wss {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  font-family: var(--font-ui);
}
.wss-project {
  overflow: hidden;
  color: var(--color-text);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wss-desc,
.wss-note,
.wss-error {
  margin: 0;
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
}
.wss-desc,
.wss-note {
  color: var(--color-text-muted);
}
.wss-error {
  color: var(--color-danger);
  overflow-wrap: anywhere;
}
.wss .wss-editor {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
}
</style>
