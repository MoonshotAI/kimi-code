<script setup lang="ts" generic="T">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';

const props = withDefaults(defineProps<{
  items: readonly T[];
  itemKey: (item: T, index: number) => string;
  itemSize: number;
  gap?: number;
  enabled?: boolean;
  overscan?: number;
  scrollRoot?: string;
}>(), { gap: 0, enabled: true, overscan: 1, scrollRoot: '' });

type Entry = { key: string; index: number; space: number };

const root = ref<HTMLElement | null>(null);
const viewport = shallowRef<{ top: number; height: number } | null>(null);
const pinned = shallowRef<ReadonlySet<string>>(new Set());
const focused = ref<string | null>(null);
let scroller: HTMLElement | null = null;
let observer: ResizeObserver | null = null;

const stride = computed(() => props.itemSize + props.gap);
const keys = computed(() => props.items.map(props.itemKey));
const positions = computed(() => new Map(keys.value.map((key, index) => [key, index])));

const layout = computed<{ entries: Entry[]; spaceAfter: number }>(() => {
  const count = keys.value.length;
  if (!props.enabled || count === 0) return { entries: [], spaceAfter: 0 };
  const chosen = new Set<number>();
  if (viewport.value) {
    const { top, height } = viewport.value;
    const padding = Math.max(400, height * props.overscan);
    const first = Math.max(0, Math.floor((top - padding) / stride.value));
    const last = Math.min(count - 1, Math.ceil((top + height + padding) / stride.value));
    for (let i = first; i <= last; i++) chosen.add(i);
  }
  for (const key of [...pinned.value, focused.value]) {
    const index = key === null ? undefined : positions.value.get(key);
    if (index !== undefined) chosen.add(index);
  }
  const entries: Entry[] = [];
  let previous = -1;
  for (const index of [...chosen].sort((a, b) => a - b)) {
    const space = previous < 0 ? index * stride.value : index > previous + 1 ? (index - previous) * stride.value - props.itemSize : 0;
    entries.push({ key: keys.value[index]!, index, space });
    previous = index;
  }
  return { entries, spaceAfter: previous < 0 ? (count - 1) * stride.value + props.itemSize : (count - 1 - previous) * stride.value };
});

function measure(): void {
  const el = root.value;
  if (!el || !scroller) return;
  const top = scroller.getBoundingClientRect().top - el.getBoundingClientRect().top;
  const height = scroller.clientHeight;
  if (top !== viewport.value?.top || height !== viewport.value.height) viewport.value = { top, height };
}

function trackFocus(): void {
  const el = root.value;
  const active = document.activeElement;
  let key: string | null = null;
  if (el && active && active !== el && el.contains(active)) {
    let node: Element = active;
    while (node.parentElement && node.parentElement !== el) node = node.parentElement;
    const rows = [...el.children].filter(child => !child.classList.contains('virtual-space'));
    key = layout.value.entries[rows.indexOf(node)]?.key ?? null;
  }
  focused.value = key;
}

function onFocusChange(): void {
  queueMicrotask(trackFocus);
}

async function reveal(key: string): Promise<void> {
  if (!positions.value.has(key)) return;
  pinned.value = new Set([...pinned.value, key]);
  await nextTick();
}

function release(): void {
  measure();
  if (pinned.value.size) pinned.value = new Set();
}

onMounted(() => {
  const el = root.value;
  if (!el) return;
  scroller = (props.scrollRoot ? el.closest<HTMLElement>(props.scrollRoot) : null) ?? el.parentElement;
  if (!scroller) return;
  scroller.addEventListener('scroll', measure, { passive: true });
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(measure);
    observer.observe(scroller);
  }
  measure();
});

onBeforeUnmount(() => {
  scroller?.removeEventListener('scroll', measure);
  observer?.disconnect();
});

defineExpose({ reveal, release });
</script>

<template>
  <template v-if="!enabled"><slot v-for="(item, index) in items" :key="itemKey(item, index)" :item="item" :index="index" /></template>
  <div v-else ref="root" class="virtual-list" @focusin="onFocusChange" @focusout="onFocusChange">
    <template v-for="entry in layout.entries" :key="entry.key">
      <div v-if="entry.space > 0" class="virtual-space" aria-hidden="true" :style="{ height: `${entry.space}px` }" />
      <slot :item="items[entry.index]!" :index="entry.index" />
    </template>
    <div v-if="layout.spaceAfter > 0" class="virtual-space" aria-hidden="true" :style="{ height: `${layout.spaceAfter}px` }" />
  </div>
</template>

<style scoped>
.virtual-list { min-width: 0; overflow-anchor: none; }
.virtual-space { pointer-events: none; overflow-anchor: none; }
</style>
