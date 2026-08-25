<!-- Head row of a dock work panel: leading icon + title + muted trailing
     meta (running count, wall-clock), with a right-aligned actions slot
     (filter chips / goal controls). -->
<script setup lang="ts">
import { Icon } from '@moonshot-ai/app-ui';

defineProps<{
  icon: string;
  title: string;
  /** Muted trailing note — hidden while empty. */
  meta?: string;
}>();
</script>

<template>
  <span class="wp-head-tab">
    <Icon :name="icon" size="md" />
    <span>{{ title }}</span>
    <span v-if="meta" class="wp-head-meta">{{ meta }}</span>
  </span>
  <span v-if="$slots.actions" class="wp-head-actions">
    <slot name="actions" />
  </span>
</template>

<style scoped>
/* One tab vocabulary for all four work heads: an inline icon + label row
   with no fill or padding of its own — the panel's 16px inset carries it. */
.wp-head-tab {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0;
  border: 0.5px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  line-height: var(--leading-solid);
  /* Never wraps and never shrinks — by layout, not by clipping: the filter
     collapses into a dropdown to free the space, so there is nothing to
     truncate. (An overflow/ellipsis here would clip descenders at this
     line-height.) */
  white-space: nowrap;
  flex: none;
}
/* The leading icon matches the work pill's 1.5em — same glyph size on the
   pill and the panel head it opens. */
.wp-head-tab :deep(svg) {
  width: 1.5em;
  height: 1.5em;
}
.wp-head-meta {
  color: var(--color-text-muted);
  text-autospace: normal;
}
.wp-head-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex: none;
}
/* Narrow widths: the head wraps (ChatDock's .dock-work-head rule) so the
   actions take a full row instead of clipping. */
@media (max-width: 480px) {
  .wp-head-actions {
    flex-basis: 100%;
    margin-left: 0;
  }
}
/* Touch: the filter items and head icon actions meet the 44px minimum hit
   size (glyph sizes unchanged). The width gate alone would miss tablets, so
   the touch-capability query rides alongside it. */
@media (hover: none) {
  .wp-head-actions :deep(.ui-seg__item) {
    min-height: var(--touch-target-min);
  }
}
@media (max-width: 640px), (hover: none) {
  .wp-head-actions :deep(.ui-seg__item) {
    height: var(--touch-target-min);
  }
  .wp-head-actions :deep(.ui-icon-button) {
    width: var(--touch-target-min);
    height: var(--touch-target-min);
  }
  .wp-head-actions :deep(.fc-trigger) {
    min-height: var(--touch-target-min);
  }
}
</style>
