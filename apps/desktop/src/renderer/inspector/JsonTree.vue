<script setup lang="ts">
import { computed, ref } from 'vue';
import { Button, Icon } from '@moonshot-ai/app-ui';

const props = withDefaults(defineProps<{ value: unknown; name?: string; depth?: number; root?: boolean }>(), { depth: 0, root: false });
const expanded = ref(false);
const kind = computed(() => {
  if (props.value === null) return 'null';
  if (Array.isArray(props.value)) return 'array';
  return typeof props.value;
});
const entries = computed<[string, unknown][]>(() => {
  if (Array.isArray(props.value)) return props.value.map((item, index) => [String(index), item]);
  if (props.value && typeof props.value === 'object') return Object.entries(props.value as Record<string, unknown>);
  return [];
});
const open = ref(props.root || (props.depth < 1 && entries.value.length <= 8) || (props.depth < 2 && entries.value.length <= 4));
const isBranch = computed(() => (kind.value === 'object' || kind.value === 'array') && entries.value.length > 0);
const isLongString = computed(() => typeof props.value === 'string' && (props.value.length > 280 || props.value.includes('\n')));
const stringText = computed(() => {
  if (typeof props.value !== 'string') return '';
  if (expanded.value || !isLongString.value) return props.value;
  return `${props.value.slice(0, 240).replace(/\s+/g, ' ').trim()}…`;
});
const summary = computed(() => {
  if (kind.value === 'array') return `[${entries.value.length}]`;
  if (kind.value === 'object') return `{${entries.value.slice(0, 3).map(([key]) => key).join(', ')}${entries.value.length > 3 ? ', …' : ''}}`;
  if (kind.value === 'string') return JSON.stringify(stringText.value);
  return String(props.value);
});
</script>

<template>
  <div v-if="root && isBranch" class="json-root">
    <JsonTree v-for="[key, child] in entries" :key="key" :name="key" :value="child" :depth="depth + 1" />
  </div>
  <details v-else-if="isBranch" class="json-branch" :open="open" @toggle="open = ($event.target as HTMLDetailsElement).open">
    <summary><Icon class="disclosure" name="chevron-right" size="sm" /><span v-if="name !== undefined" class="key">{{ name }}</span><span class="meta">{{ summary }}</span></summary>
    <div v-if="open" class="children">
      <JsonTree v-for="[key, child] in entries" :key="key" :name="key" :value="child" :depth="depth + 1" />
    </div>
  </details>
  <div v-else class="json-leaf" :class="{ multiline: isLongString && expanded }">
    <span v-if="name !== undefined" class="key">{{ name }}</span>
    <span class="value" :data-kind="kind">{{ isLongString && expanded ? stringText : summary }}</span>
    <Button v-if="isLongString" size="xs" variant="text" @click="expanded = !expanded">{{ expanded ? '−' : `+${String(value).length.toLocaleString()}` }}</Button>
  </div>
</template>

<style scoped>
.json-root { min-width: 0; font: var(--text-xs) var(--font-mono); }
.json-branch, .json-leaf { font: var(--text-xs) var(--font-mono); line-height: var(--leading-normal); }
summary, .json-leaf { display: flex; align-items: baseline; gap: var(--space-2); min-height: var(--space-6); padding: 0 var(--space-2); border-radius: var(--radius-xs); }
summary { cursor: pointer; list-style: none; user-select: none; }
summary::-webkit-details-marker { display: none; }
summary:hover, .json-leaf:hover { background: var(--color-hover); }
summary:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.disclosure { color: var(--color-text-faint); flex: none; align-self: center; }
details[open] > summary > .disclosure { transform: rotate(90deg); }
.children { margin-left: var(--space-3); padding-left: var(--space-2); border-left: var(--p-hairline) solid var(--color-line); }
.key { color: var(--color-text-muted); flex: none; }
.key::after { content: ':'; color: var(--color-text-faint); }
.meta { color: var(--color-text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.value { color: var(--color-text); min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.multiline { align-items: flex-start; }
.value[data-kind="string"] { color: var(--color-syntax-string); }
.value[data-kind="number"] { color: var(--color-syntax-number); }
.value[data-kind="boolean"], .value[data-kind="null"] { color: var(--color-syntax-keyword); }
</style>
