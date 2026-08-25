<!-- The session's latest plan inside the dock's shared work panel (opened
     from the plan pill): the model's written plan rendered with the app's
     full chat Markdown renderer (tables, code, links — same fidelity as the
     transcript) + its review details. While plan mode is live and nothing
     is written yet, an empty state says what's coming. The review state, the
     open-in-side-panel entry, and the cancel-directive action all ride the
     panel's head (in ChatDock.vue). -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { computed } from 'vue';
import { Button, Icon } from '@moonshot-ai/app-ui';
import { Markdown } from '@moonshot-ai/app-markdown';
import type { SessionPlan } from '@moonshot-ai/app-core/api';
import type { FilePreviewRequest } from '@moonshot-ai/app-core/client/types';

const props = defineProps<{
  /** The latest persisted plan for the session (undefined before the first
      ExitPlanMode). */
  plan?: SessionPlan;
  /** Plan mode is live server-side — drives the empty text. (A merely armed
      directive never opens this panel; see ChatDock's plan pill.) */
  planModeOn?: boolean;
  openFile?: (target: FilePreviewRequest) => void;
}>();

const { t } = useI18n();

/** A path-only record (an old daemon's transcript carries no inline plan
    text) — the body must not render blank. */
const pathOnlyPlan = computed(() =>
  props.plan && !props.plan.plan && props.plan.path ? props.plan.path : undefined,
);
function openPathOnlyPlan(): void {
  if (pathOnlyPlan.value) props.openFile?.({ path: pathOnlyPlan.value });
}

</script>

<template>
  <div class="plan-panel">
    <template v-if="plan">
      <div v-if="plan.review?.selectedOption" class="plan-review-row">
        <span class="plan-review-label">{{ t('tools.plan.selectedOption') }}</span>
        <span>{{ plan.review.selectedOption }}</span>
      </div>
      <div v-if="plan.review?.feedback" class="plan-review-row">
        <span class="plan-review-label">{{ t('tools.plan.feedback') }}</span>
        <span class="plan-review-feedback">{{ plan.review.feedback }}</span>
      </div>
      <Markdown v-if="plan.plan" :text="plan.plan" :open-file="openFile" />
      <div v-if="pathOnlyPlan" class="plan-path-only">
        <span class="plan-path-hint">{{ t('tools.plan.pathOnlyHint') }}</span>
        <Button variant="ghost" size="sm" class="plan-path" @click="openPathOnlyPlan">{{ pathOnlyPlan }}</Button>
      </div>
    </template>
    <div v-else class="plan-empty">
      <Icon name="file-edit" size="lg" class="plan-empty-ico" />
      <span>{{ planModeOn ? t('status.planEmptyArmed') : t('status.planEmptyIdle') }}</span>
    </div>
  </div>
</template>

<style scoped>
.plan-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.plan-review-row {
  display: flex;
  gap: var(--space-2);
  font-size: var(--text-sm);
}
.plan-review-label {
  flex: none;
  color: var(--color-text-muted);
}
.plan-review-feedback {
  color: var(--color-text-muted);
}
.plan-path-only {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-1);
}
.plan-path-hint {
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}
/* The primitive owns chrome + focus; this only sets the path's mono look
   and single-line truncation. */
.plan-path {
  max-width: 100%;
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plan-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-6) var(--space-4);
  color: var(--color-text-faint);
  font-size: var(--text-sm);
}
.plan-empty-ico { width: var(--p-empty-ico); height: var(--p-empty-ico); color: var(--color-line-strong); }
</style>
