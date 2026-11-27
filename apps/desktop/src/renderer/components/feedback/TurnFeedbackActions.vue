<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { IconButton } from '@moonshot-ai/app-ui';
import { DesktopFeedbackKey, type TurnFeedbackTarget } from '../../composables/useDesktopFeedback';
import TurnFeedbackPopover from './TurnFeedbackPopover.vue';

const props = defineProps<{ target: TurnFeedbackTarget | undefined }>();
const { t } = useI18n();
const feedback = inject(DesktopFeedbackKey);
const downButton = ref<InstanceType<typeof IconButton>>();
const popoverId = useId();
const state = computed(() => feedback?.state(props.target));
const activeRating = computed(() => {
  const current = state.value;
  return current?.kind === 'saving' ? current.rating : current?.record.rating;
});
const open = computed(() => feedback?.isPopoverOpen(props.target) === true);
const pending = computed(() => state.value !== undefined && state.value.kind !== 'recorded');

function prefetchForm(): void {
  const sessionId = props.target?.sessionId;
  if (sessionId !== undefined && feedback) feedback.prefetchForm(sessionId);
}

onBeforeUnmount(() => {
  if (open.value) feedback?.closePopover(props.target);
});
</script>

<template>
  <div v-if="target && feedback" class="feedback-actions">
    <IconButton
      v-if="activeRating !== 'down'"
      size="xs"
      :label="t(activeRating === 'up' ? 'feedback.undoUp' : 'feedback.up')"
      :tooltip="t(activeRating === 'up' ? 'feedback.undoUp' : 'feedback.up')"
      :pressed="activeRating === 'up'"
      :disabled="pending"
      @pointerenter="prefetchForm"
      @focus="prefetchForm"
      @click="feedback.chooseRating(target, 'up')"
    >
      <span class="rating-icon rating-like" aria-hidden="true" />
    </IconButton>
    <IconButton
      v-if="activeRating !== 'up'"
      ref="downButton"
      size="xs"
      :label="t(activeRating === 'down' ? 'feedback.undoDown' : 'feedback.down')"
      :tooltip="open ? undefined : t(activeRating === 'down' ? 'feedback.undoDown' : 'feedback.down')"
      :pressed="activeRating === 'down'"
      :aria-expanded="open"
      :aria-controls="open ? popoverId : undefined"
      aria-haspopup="dialog"
      :disabled="pending"
      @pointerenter="prefetchForm"
      @focus="prefetchForm"
      @click="feedback.chooseRating(target, 'down')"
    >
      <span class="rating-icon rating-dislike" aria-hidden="true" />
    </IconButton>
    <Teleport to="body">
      <TurnFeedbackPopover
        v-if="open && downButton?.el"
        :id="popoverId"
        :key="target.replyId"
        :anchor="downButton.el"
        :target="target"
        :saving="state?.kind === 'saving'"
        :updating="state?.kind === 'updating'"
        @close="feedback.closePopover(target)"
      />
    </Teleport>
  </div>
</template>

<style scoped>
.feedback-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}
.feedback-actions .ui-icon-button {
  border: 0;
}
.feedback-actions .ui-icon-button:hover:not(:disabled) {
  background: var(--color-hover);
  color: var(--color-accent);
}
.feedback-actions .ui-icon-button[aria-pressed='true'],
.feedback-actions .ui-icon-button[aria-pressed='true']:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-accent) 10%, transparent);
  color: var(--color-accent);
}
.rating-icon {
  width: 14px;
  height: 14px;
  background: currentColor;
  mask-position: center;
  mask-repeat: no-repeat;
}
.rating-like { mask-image: url('./assets/like.svg'); }
.rating-dislike { mask-image: url('./assets/dislike.svg'); }
</style>
