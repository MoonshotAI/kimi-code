<!-- apps/kimi-web/src/components/chat/ToolRow.vue -->
<script setup lang="ts">
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

defineEmits<{ toggle: [] }>();
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
    <div class="bh" @click="$emit('toggle')">
      <span v-if="icon" class="gl" v-html="icon" aria-hidden="true" />
      <span class="a">{{ name }}</span>
      <Tooltip :text="arg">
        <span v-if="arg" class="p">{{ arg }}</span>
      </Tooltip>
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
.a {
  color: var(--color-text);
  font-weight: var(--weight-medium);
  flex: none;
}
.p {
  color: var(--color-text-muted);
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

/* Expanded detail: sunken panel under the row, indented to align with the name.
   Collapses/expands via a height transition; `interpolate-size: allow-keywords`
   (set on :root) lets `height: auto` interpolate instead of snap. The visual
   styles live on `.bb-pad` so they clip cleanly inside the 0-height clip box. */
.bb {
  height: 0;
  overflow: hidden;
  transition: height var(--duration-base) var(--ease-out);
}
.bb.open {
  height: auto;
}
.bb-pad {
  padding: 0 11px 11px 36px;
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
