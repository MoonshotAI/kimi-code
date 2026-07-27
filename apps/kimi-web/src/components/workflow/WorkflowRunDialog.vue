<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Dialog from '../ui/Dialog.vue';
import Button from '../ui/Button.vue';
import Icon from '../ui/Icon.vue';
import Input from '../ui/Input.vue';

const { t } = useI18n();

const props = defineProps<{
  open: boolean;
  workflowName: string;
}>();

const emit = defineEmits<{
  close: [];
  run: [args?: string];
}>();

const args = ref('');

function handleRun(): void {
  emit('run', args.value || undefined);
  args.value = '';
}

function handleClose(): void {
  args.value = '';
  emit('close');
}
</script>

<template>
  <Dialog
    :open="open"
    :title="t('workflow.runWorkflow')"
    size="md"
    @close="handleClose"
  >
    <div class="wf-run-dialog">
      <p class="wf-run-desc">{{ t('workflow.confirmRunDesc') }}</p>
      <div class="wf-run-name-row">
        <Icon name="file-text" size="md" />
        <span class="wf-run-name">{{ workflowName }}</span>
      </div>
      <Input
        v-model="args"
        :placeholder="t('workflow.argsPlaceholder')"
        class="wf-run-args"
      />
      <div class="wf-run-actions">
        <Button variant="secondary" @click="handleClose">
          {{ t('workflow.cancel') }}
        </Button>
        <Button variant="primary" @click="handleRun">
          <Icon name="play" size="sm" />
          <span>{{ t('workflow.runNow') }}</span>
        </Button>
      </div>
    </div>
  </Dialog>
</template>

<style scoped>
.wf-run-dialog {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.wf-run-desc {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--dim);
  line-height: 1.5;
}
.wf-run-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 500;
}
.wf-run-name {
  font-size: var(--text-base);
}
.wf-run-args {
  width: 100%;
}
.wf-run-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
</style>
