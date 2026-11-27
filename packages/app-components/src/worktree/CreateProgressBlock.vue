<script setup lang="ts">
import { computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppSessionWorktree } from '@moonshot-ai/app-core/api';
import { Icon, Spinner } from '@moonshot-ai/app-ui';
import { useHistoryState } from '../chat/historyState';
import { recallCreateRun, rememberCreateRun } from './createBlockMemory';
import { createBlockView } from './createPresentation';
import WorktreeCommand from './WorktreeCommand.vue';
import WorktreeOutput from './WorktreeOutput.vue';

const props = defineProps<{
  worktree: AppSessionWorktree;
  sessionId?: string | null;
}>();

const { t } = useI18n();

watch(
  () => [props.sessionId, props.worktree] as const,
  ([sessionId, worktree]) => {
    if (sessionId !== undefined && sessionId !== null) rememberCreateRun(sessionId, worktree);
  },
  { immediate: true },
);

const view = computed(() =>
  createBlockView(
    props.worktree,
    t,
    props.sessionId === undefined || props.sessionId === null ? null : recallCreateRun(props.sessionId),
  ),
);

const open = useHistoryState<boolean>('worktree-create:open', view.value.defaultOpen);
const effectiveOpen = computed(() => view.value.expandable && open.value);

watch(
  () => `${props.worktree.setup.purpose}:${props.worktree.setup.status}`,
  () => {
    open.value = view.value.defaultOpen;
  },
);

function toggle(): void {
  if (!view.value.expandable) return;
  open.value = !open.value;
}
</script>

<template>
  <div class="wcb" :class="{ open: effectiveOpen }" data-worktree-create-block>
    <component
      :is="view.expandable ? 'button' : 'div'"
      class="wcb-head disclosure-head"
      :class="{ 'is-static': !view.expandable }"
      v-bind="
        view.expandable
          ? {
              type: 'button',
              'aria-expanded': effectiveOpen,
              'aria-label': t(effectiveOpen ? 'worktreeCreate.block.collapse' : 'worktreeCreate.block.expand'),
            }
          : {}
      "
      @click="toggle"
    >
      <span class="wcb-title" role="status">{{ view.title }}</span>
      <span v-if="view.meta" class="wcb-meta">{{ view.meta }}</span>
      <Icon v-if="view.expandable" class="wcb-car" name="chevron-down" size="sm" aria-hidden="true" />
    </component>
    <p v-if="view.note" class="wcb-note">{{ view.note }}</p>
    <ol v-if="effectiveOpen" class="wcb-steps">
      <li
        v-for="step in view.steps"
        :key="step.key"
        class="wcb-step"
        :class="[`is-${step.tone}`, { connected: step.connected }]"
        :data-step="step.kind"
        :data-state="step.tone"
      >
        <span class="wcb-glyph" aria-hidden="true">
          <Spinner v-if="step.tone === 'running'" size="sm" />
          <Icon v-else-if="step.tone === 'done'" name="check" size="md" />
          <Icon v-else-if="step.tone === 'failed'" name="alert-triangle" size="md" />
          <span v-else class="wcb-circle" />
        </span>
        <span class="wcb-label">{{ step.label }}</span>
        <WorktreeCommand v-if="step.command" class="wcb-command" :text="step.command" />
        <WorktreeOutput v-if="step.output && step.tone !== 'done'" class="wcb-output" :text="step.output" />
      </li>
    </ol>
  </div>
</template>

<style scoped src="../lib/disclosure-head.css"></style>
<style scoped>
.wcb {
  box-sizing: border-box;
  align-self: stretch;
  width: 100%;
  margin-top: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-xl);
  background: var(--color-bg);
  font-family: var(--font-ui);
  text-align: left;
  animation: kimi-card-in var(--duration-base) var(--ease-out);
}
.wcb-head {
  color: var(--color-text);
  font-family: inherit;
}
.wcb-head.is-static {
  cursor: default;
}
.wcb-head:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.wcb-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-weight: var(--weight-semibold);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wcb-meta {
  flex: none;
  color: var(--color-text-muted);
  transition: color var(--duration-base) var(--ease-out);
}
.wcb-head:not(.is-static):hover .wcb-meta {
  color: var(--color-text);
}
.wcb-car {
  flex: none;
  width: 13px;
  height: 13px;
  color: var(--color-text-muted);
  transform: rotate(-90deg);
  transition: transform var(--duration-base) var(--ease-out);
}
.wcb.open .wcb-car {
  transform: none;
}
.wcb-note {
  margin: var(--space-1) 0 0;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
}
.wcb-steps {
  margin: var(--space-3) 0 0;
  padding: 0;
  list-style: none;
}
.wcb-step {
  --wcb-line: calc(var(--text-base) * var(--leading-normal));
  position: relative;
  display: grid;
  grid-template-columns: 15px minmax(0, 1fr);
  column-gap: var(--space-2);
  padding-bottom: var(--space-2);
  color: var(--color-text-muted);
}
.wcb-step:last-child {
  padding-bottom: 0;
}
.wcb-step.connected::after {
  content: '';
  position: absolute;
  top: var(--wcb-line);
  bottom: var(--space-05);
  left: 7px;
  width: 1px;
  background: var(--color-line);
}
.wcb-glyph {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: var(--wcb-line);
}
.wcb-step.is-done .wcb-glyph {
  color: var(--color-success);
}
.wcb-step.is-running {
  color: var(--color-text);
}
.wcb-step.is-failed {
  color: var(--color-danger);
}
.wcb-circle {
  box-sizing: border-box;
  width: 11px;
  height: 11px;
  border: 1.25px solid var(--color-line-strong);
  border-radius: var(--radius-full);
}
.wcb-label {
  min-width: 0;
  font-size: var(--text-base);
  line-height: var(--wcb-line);
  overflow-wrap: anywhere;
}
.wcb-command,
.wcb-output {
  grid-column: 2;
}
.wcb-command {
  margin-top: 3px;
}
.wcb-step.is-running .wcb-command {
  color: var(--color-text-muted);
}
.wcb-output {
  margin-top: var(--space-2);
}
</style>
