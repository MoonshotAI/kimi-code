<!-- apps/kimi-web/src/components/chat/ToolRow.vue -->
<script setup lang="ts">
import { inject, nextTick, ref } from 'vue';
import Icon from '../ui/Icon.vue';
import Tooltip from '../ui/Tooltip.vue';
import StatusDot from '../ui/StatusDot.vue';

withDefaults(
  defineProps<{
    status: 'running' | 'ok' | 'error' | 'suspended';
    /** Inline-SVG glyph string (toolGlyph), or empty for none. */
    icon?: string;
    name: string;
    arg?: string;
    time?: string;
    open?: boolean;
    expandable?: boolean;
    stacked?: boolean;
    stackPosition?: 'single' | 'first' | 'middle' | 'last';
  }>(),
  {
    icon: '',
    arg: '',
    time: '',
    open: false,
    expandable: false,
    stacked: false,
    stackPosition: 'single',
  },
);

const emit = defineEmits<{ toggle: [] }>();

const pinScroll = inject<(el: HTMLElement, ms?: number) => void>('pinScroll', () => {});
const bhEl = ref<HTMLElement | null>(null);

function onHeadClick(): void {
  emit('toggle');
  const el = bhEl.value;
  if (el) nextTick(() => pinScroll(el));
}
</script>

<template>
  <div
    class="box"
    :class="{
      open,
      stacked,
      err: status === 'error',
      'stack-first': stackPosition === 'first',
      'stack-middle': stackPosition === 'middle',
      'stack-last': stackPosition === 'last',
    }"
  >
    <div class="bh" ref="bhEl" @click="onHeadClick">
      <span v-if="icon" class="gl" v-html="icon" aria-hidden="true" />
      <span class="bh-text">
        <span class="a">{{ name }}</span>
        <Tooltip :text="arg">
          <span v-if="arg" class="p">{{ arg }}</span>
        </Tooltip>
      </span>
      <span class="rt">
        <span class="status" :class="status" role="status" :aria-label="status">
          <Icon v-if="status === 'ok'" name="check" size="sm" />
          <Icon v-else-if="status === 'error'" name="close" size="sm" />
          <StatusDot v-else-if="status === 'suspended'" status="suspended" />
          <StatusDot v-else status="running" />
        </span>
        <slot name="trailing" />
        <span v-if="time" class="tm">{{ time }}</span>
      </span>
      <Icon v-if="expandable" class="car" :name="open ? 'chevron-down' : 'chevron-right'" size="sm" />
    </div>
    <div class="bb" :class="{ open }" :inert="!open">
      <div class="bb-pad">
        <slot />
      </div>
    </div>
  </div>
</template>

<style scoped>
.box {
  margin: 0;
  background: var(--color-surface);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  overflow: hidden;
  transition: border-color var(--duration-base) var(--ease-out);
}
.box.err {
  border-color: color-mix(in srgb, var(--color-danger) 25%, var(--bg));
}

/* Stacked calls: the group owns the outer border + radius, so each row is flat
   and separated only by a top hairline. */
.box.stacked {
  border: none;
  border-radius: 0;
}
.box.stacked .bh {
  border-radius: 0;
}
.box.stack-middle,
.box.stack-last {
  border-top: 1px solid var(--color-line);
}

.bh {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 30px;
  padding: 0 11px;
  cursor: pointer;
  font: var(--text-sm) var(--font-mono);
  color: var(--color-text);
}
.box.open .bh,
.bh:hover {
  background: var(--color-surface-sunken);
}
.box.err .bh {
  background: color-mix(in srgb, var(--color-danger) 4%, var(--bg));
}
.box.err .bh:hover {
  background: color-mix(in srgb, var(--color-danger) 7%, var(--bg));
}

.gl {
  display: inline-flex;
  align-items: center;
  color: var(--color-text-faint);
  flex: none;
}
.bh-text {
  display: flex;
  align-items: baseline;
  gap: inherit;
  flex: 1;
  min-width: 0;
}
.a {
  color: var(--color-text);
  font-weight: var(--weight-medium);
  flex: none;
}
.p {
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
.rt {
  margin-left: auto;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}
.tm {
  color: var(--color-text-faint);
}
:slotted(.chip) {
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  flex: none;
}

/* Status indicator at the right edge of the row: done = green ✓, error = red ✗,
   running = pulsing accent dot. */
.status {
  display: inline-flex;
  align-items: center;
  flex: none;
}
.status.ok {
  color: var(--color-success);
}
.status.error {
  color: var(--color-danger);
}

/* Expanded detail: sunken panel under the row. Opens downward / collapses upward
   via a `grid-template-rows` transition (0fr ↔ 1fr), which animates smoothly in
   every modern browser — unlike `height: auto`, which only interpolates in
   Chromium (via `interpolate-size`) and snaps everywhere else. The inner
   `.bb-pad` needs `min-height: 0` + `overflow: hidden` so the 0fr track can
   collapse fully. */
.bb {
  display: grid;
  grid-template-rows: minmax(0, 0fr);
  overflow: hidden;
  transition: grid-template-rows var(--duration-base) var(--ease-out);
}
.bb.open {
  grid-template-rows: minmax(0, 1fr);
}
.bb-pad {
  min-height: 0;
  overflow: hidden;
  padding: var(--space-2) var(--space-3) var(--space-3);
  background: var(--color-surface-sunken);
  border-top: 1px solid var(--color-line);
  color: var(--color-text);
  font: var(--text-sm)/1.65 var(--font-mono);
  white-space: pre-wrap;
  word-break: break-word;
}

/* Mobile bubble layout: no left gutter indent, softer corners. */
.box.mob {
  margin: 0;
}
</style>
