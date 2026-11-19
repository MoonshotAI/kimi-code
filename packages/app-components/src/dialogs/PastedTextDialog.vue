<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, Dialog, Icon, Textarea } from '@moonshot-ai/app-ui';
import { useConfirmDialog } from '@moonshot-ai/app-client/composables';
import { copyTextToClipboard } from '@moonshot-ai/app-core/lib';
import { pastedTextCharCount, pastedTextLineCount } from '@moonshot-ai/app-composer/model';
import { closePastedTextDialog, pastedTextDialogState, usePastedTextStats } from './pastedTextDialog';

const { t } = useI18n();
const { confirm } = useConfirmDialog();
const copied = ref(false);
let copiedTimer: number | undefined;
let confirming = false;

const draft = ref('');
watch(pastedTextDialogState, (state) => {
  draft.value = state?.text ?? '';
}, { immediate: true });

const editable = computed(() => pastedTextDialogState.value?.save !== undefined);
const dirty = computed(() => editable.value && draft.value !== pastedTextDialogState.value?.text);
const stats = usePastedTextStats();
const description = computed(() => stats(pastedTextLineCount(draft.value), pastedTextCharCount(draft.value)));

async function requestClose(): Promise<void> {
  if (!dirty.value) {
    closePastedTextDialog();
    return;
  }
  if (confirming) return;
  confirming = true;
  try {
    const discard = await confirm({
      title: t('composer.pastedTextDiscardTitle'),
      message: t('composer.pastedTextDiscardMessage'),
      confirmLabel: t('composer.pastedTextDiscard'),
      variant: 'danger',
    });
    if (discard) closePastedTextDialog();
  } finally {
    confirming = false;
  }
}

function onOpenChange(open: boolean): void {
  if (!open) void requestClose();
}

function onPrimary(): void {
  const state = pastedTextDialogState.value;
  if (dirty.value && state?.save !== undefined) state.save(draft.value);
  closePastedTextDialog();
}

async function onCopy(): Promise<void> {
  if (!(await copyTextToClipboard(draft.value))) return;
  copied.value = true;
  window.clearTimeout(copiedTimer);
  copiedTimer = window.setTimeout(() => {
    copied.value = false;
  }, 1500);
}
</script>

<template>
  <Dialog
    :open="pastedTextDialogState !== null"
    :title="t('composer.pastedTextTitle')"
    :description="description"
    size="lg"
    panel-class="pasted-text-dialog"
    initial-focus=".pasted-text-dialog__text"
    @update:open="onOpenChange"
  >
    <div class="pasted-text-dialog__frame">
      <Textarea
        v-model="draft"
        class="pasted-text-dialog__text"
        :rows="18"
        :resize="false"
        :readonly="!editable"
      />
    </div>
    <template #foot>
      <Button variant="secondary" @click="onCopy">
        <Icon :name="copied ? 'check' : 'copy'" size="sm" />
        {{ copied ? t('composer.pastedTextCopied') : t('common.copy') }}
      </Button>
      <Button variant="primary" @click="onPrimary">
        <Icon :name="dirty ? 'check' : 'close'" size="sm" />
        {{ dirty ? t('composer.pastedTextSave') : t('common.close') }}
      </Button>
    </template>
  </Dialog>
</template>

<style scoped>
:global(.pasted-text-dialog .ui-dialog__body) {
  padding-bottom: 4px;
}
.pasted-text-dialog__frame {
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
}
.pasted-text-dialog__frame:focus-within {
  box-shadow: var(--p-focus-ring);
}
.pasted-text-dialog__frame .pasted-text-dialog__text {
  display: block;
  width: 100%;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  white-space: pre;
  overflow: auto;
  box-shadow: none;
  clip-path: inset(0 round var(--radius-md));
}
</style>
