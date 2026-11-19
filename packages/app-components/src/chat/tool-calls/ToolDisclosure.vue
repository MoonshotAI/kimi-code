<script setup lang="ts">
import { computed, inject, nextTick, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon, StatusDot, Tooltip } from '@moonshot-ai/app-ui';
import { PinScrollKey, track } from '@moonshot-ai/app-client/contracts';

const props = withDefaults(
  defineProps<{
    status: 'running' | 'ok' | 'error' | 'suspended' | 'cancelled';
    open?: boolean;
    expandable?: boolean;
  }>(),
  { open: false, expandable: false },
);

const emit = defineEmits<{ toggle: [] }>();

const { t } = useI18n();

const pinScroll = inject(PinScrollKey, () => {});
const headEl = ref<HTMLElement | null>(null);

function toggle(): void {
  if (!props.expandable) return;
  track('ui_element_toggled', { element: 'tool_call', expanded: !props.open, sample_rate: 1 });
  emit('toggle');
  const el = headEl.value;
  if (el) nextTick(() => pinScroll(el));
}

const chevronLabel = computed(() =>
  props.open ? t('tools.disclosure.collapse') : t('tools.disclosure.expand'),
);
</script>

<template>
  <div class="tool-line" :class="{ open, expandable, err: status === 'error' }">
    <div ref="headEl" class="tl-head" :class="{ clickable: expandable }" @click="toggle">
      <span class="tl-ic" aria-hidden="true"><slot name="leading" /></span>
      <span class="tl-main">
        <span class="tl-lead">
          <slot />
          <Tooltip v-if="expandable" :text="chevronLabel">
            <button
              class="tl-car"
              type="button"
              :aria-expanded="open"
              :aria-label="chevronLabel"
              @click.stop="toggle"
            >
              <Icon class="tl-car-ic" name="chevron-right" size="sm" aria-hidden="true" />
            </button>
          </Tooltip>
        </span>
        <span class="tl-tail">
          <slot name="trailing" />
          <span v-if="status !== 'ok'" class="tl-status" :class="status" role="status" :aria-label="status">
            <Icon v-if="status === 'error' || status === 'cancelled'" name="close" size="sm" />
            <StatusDot v-else-if="status === 'suspended'" status="suspended" />
            <StatusDot v-else status="running" />
          </span>
        </span>
      </span>
    </div>
    <div v-if="expandable" class="tl-body" :class="{ open }" :inert="!open">
      <div class="tl-body-inner">
        <div class="tl-body-content">
          <slot name="body" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool-line {
  --tl-gutter: 20px;
  --tl-gap: var(--space-2);
  --tl-indent: calc(var(--tl-gutter) + var(--tl-gap));
  transition: margin-top var(--duration-base) var(--ease-out);
}
@media (prefers-reduced-motion: reduce) {
  .tool-line {
    transition: none;
  }
}

.tl-head {
  display: flex;
  align-items: center;
  gap: var(--tl-gap);
  width: 100%;
  min-height: var(--tl-gutter);
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-base);
  line-height: var(--tl-gutter);
  text-align: left;
}
.tl-head.clickable {
  cursor: pointer;
  user-select: none;
}

.tl-ic {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: var(--tl-gutter);
  height: var(--tl-gutter);
  color: var(--color-text-faint);
}
.tl-ic :deep(.kw-icon) {
  width: 18px;
  height: 18px;
}

.tl-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--tl-gap);
}

.tl-lead {
  display: flex;
  align-items: center;
  gap: var(--tl-gap);
  min-width: 0;
}

.tl-tail {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
}
.tl-status {
  display: inline-flex;
  align-items: center;
  flex: none;
}
.tl-status.error {
  color: var(--color-danger);
}
.tl-status.cancelled {
  color: var(--color-text-faint);
}

.tl-car {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  align-self: center;
  width: 14px;
  height: 14px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-faint);
  cursor: pointer;
  flex: none;
}
.tl-car:hover {
  color: var(--color-text);
}
.tl-car:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.tl-car-ic {
  transition: transform var(--duration-base) var(--ease-out);
}
.tool-line.open .tl-car-ic {
  transform: rotate(90deg);
}

.tl-body {
  display: grid;
  grid-template-rows: minmax(0, 0fr);
  overflow: hidden;
  transition: grid-template-rows var(--duration-base) var(--ease-out);
}
.tl-body.open {
  grid-template-rows: minmax(0, 1fr);
}
.tl-body-inner {
  position: relative;
  min-height: 0;
  overflow: hidden;
  padding-left: var(--tl-indent);
}
.tl-body-inner::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: calc((var(--tl-gutter) - var(--p-hairline)) / 2);
  width: var(--p-hairline);
  background-image: repeating-linear-gradient(
    to bottom,
    var(--color-line) 0 2px,
    transparent 2px 4px
  );
}
.tl-body-content {
  padding-top: 6px;
  padding-bottom: var(--space-1);
}

.tl-lead :slotted(.tl-name) {
  font-weight: var(--weight-regular);
  color: var(--color-text-muted);
  flex: none;
}
.tl-lead :slotted(.tl-dim) {
  color: var(--color-text-muted);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tl-lead :slotted(.tl-faint) {
  color: var(--color-text-faint);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tl-lead :slotted(.tl-mono) {
  color: var(--color-text-muted);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tl-lead :deep(.tl-file) {
  font-weight: var(--weight-regular);
  color: var(--color-text-muted);
  flex: 0 1 auto;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  padding: 0;
  font-family: inherit;
  font-size: inherit;
  line-height: inherit;
  cursor: pointer;
}
.tl-lead :deep(.tl-file):hover {
  color: var(--color-accent);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.tl-lead :deep(.tl-file):focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.tl-lead :slotted(.tl-add) {
  color: var(--color-diff-add-fg);
  flex: none;
}
.tl-lead :slotted(.tl-del) {
  color: var(--color-diff-del-fg);
  flex: none;
}
.tl-lead :slotted(.tl-chip) {
  color: var(--color-text-faint);
  flex: none;
  white-space: nowrap;
}
.tl-tail :slotted(.tl-pill) {
  font-size: var(--text-xs);
  line-height: 1.5;
  padding: 0 var(--space-2);
  border-radius: var(--radius-full);
  flex: none;
  white-space: nowrap;
}
.tl-tail :slotted(.tl-chip) {
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  flex: none;
  white-space: nowrap;
}
.tl-tail :slotted(.tl-add) {
  color: var(--color-diff-add-fg);
  font-size: var(--text-xs);
  flex: none;
}
.tl-tail :slotted(.tl-del) {
  color: var(--color-diff-del-fg);
  font-size: var(--text-xs);
  flex: none;
}
</style>
