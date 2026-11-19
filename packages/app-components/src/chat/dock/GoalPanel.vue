<script setup lang="ts">
import { computed, inject, nextTick, ref, watch } from 'vue';
import type { AppGoal } from '@moonshot-ai/app-core/api';
import { GOAL_OBJECTIVE_MAX_LENGTH } from '@moonshot-ai/app-core/api';
import { Button, Icon, Textarea, useImeComposition } from '@moonshot-ai/app-ui';
import { Markdown } from '@moonshot-ai/app-markdown';
import { panelApiKey } from '@moonshot-ai/app-client/panel';
import { useKimiWebClient } from '@moonshot-ai/app-client/client';
import { useI18n } from 'vue-i18n';
import { createCwdAssumedResolver } from '../turnFilePathIndex';

const props = defineProps<{
  goal: AppGoal;
  editing?: boolean;
}>();

const emit = defineEmits<{
  'update:editing': [value: boolean];
}>();

const { t } = useI18n();

const panelApi = inject(panelApiKey);

const client = useKimiWebClient();
const assumedFilePathResolver = computed(() => createCwdAssumedResolver(client.status.value.cwd));

const { handleCompositionStart, handleCompositionEnd, isComposingKeyEvent } = useImeComposition();
const draft = ref('');
const saving = ref(false);
const editorRef = ref<{ el: HTMLTextAreaElement | null } | null>(null);
const trimmedLength = computed(() => draft.value.trim().length);
const tooLong = computed(() => trimmedLength.value > GOAL_OBJECTIVE_MAX_LENGTH);
const canSave = computed(() => !saving.value && trimmedLength.value > 0 && !tooLong.value);
const isEditing = computed(() => props.editing === true && props.goal.status !== 'complete');

watch(isEditing, (next) => {
  if (!next) return;
  draft.value = props.goal.objective;
  void nextTick(() => {
    const el = editorRef.value?.el;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  });
}, { immediate: true });

watch(() => props.goal.goalId, () => {
  if (props.editing) emit('update:editing', false);
});

function cancel(): void {
  if (saving.value) return;
  emit('update:editing', false);
}

async function save(): Promise<void> {
  if (!canSave.value) return;
  saving.value = true;
  try {
    const ok = await client.editGoalObjective(draft.value);
    if (ok) emit('update:editing', false);
  } finally {
    saving.value = false;
  }
}

function onEditorKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || isComposingKeyEvent(e)) return;
  e.preventDefault();
  e.stopPropagation();
  cancel();
}

function onKeydown(e: KeyboardEvent): void {
  if (isComposingKeyEvent(e)) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void save();
  }
}
</script>

<template>
  <div class="goal-panel">
    <div v-if="isEditing" class="goal-editor" @keydown="onEditorKeydown">
      <Textarea
        ref="editorRef"
        v-model="draft"
        size="sm"
        :rows="2"
        autosize
        :readonly="saving"
        :error="tooLong"
        :aria-label="t('status.goalEdit')"
        @keydown="onKeydown"
        @compositionstart="handleCompositionStart"
        @compositionend="handleCompositionEnd"
      />
      <div class="goal-editor-footer">
        <span v-if="tooLong" class="goal-editor-error">
          {{ t('status.goalEditTooLong', { count: trimmedLength, max: GOAL_OBJECTIVE_MAX_LENGTH }) }}
        </span>
        <div class="goal-editor-actions">
          <Button variant="ghost" size="sm" :disabled="saving" @click="cancel">{{ t('status.goalEditDiscard') }}</Button>
          <Button size="sm" :disabled="!canSave" :loading="saving" @click="save">{{ t('status.goalEditSave') }}</Button>
        </div>
      </div>
    </div>
    <Markdown v-else :text="goal.objective" :open-file="panelApi?.openFile" :resolve-file-path="assumedFilePathResolver" />
    <div v-if="goal.completionCriterion" class="goal-criterion">
      <span class="goal-criterion-label">
        <Icon name="check-list" size="md" />
        {{ t('status.goalDoneWhen') }}
      </span>
      <Markdown :text="goal.completionCriterion" :open-file="panelApi?.openFile" :resolve-file-path="assumedFilePathResolver" />
    </div>
  </div>
</template>

<style scoped>
.goal-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  overflow-wrap: anywhere;
  --markdown-body-line-height: calc(20 / 14);
}
.goal-panel .md :deep(.markdown-renderer > .node-slot:first-child) {
  padding-top: 0;
}
.goal-editor {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.goal-editor-footer {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.goal-editor-error {
  color: var(--color-danger);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
}
.goal-editor-actions {
  display: flex;
  gap: var(--space-1-5);
  margin-left: auto;
}
.goal-criterion {
  padding-top: var(--space-2);
  border-top: var(--p-hairline) solid var(--color-line);
}
.goal-criterion-label {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--text-base);
  font-weight: var(--weight-regular);
  line-height: round(calc(var(--text-base) * 1.42), 1px);
  margin-bottom: var(--space-2);
}
.goal-criterion-label :deep(svg) {
  width: var(--p-ic-dock);
  height: var(--p-ic-dock);
}
</style>
