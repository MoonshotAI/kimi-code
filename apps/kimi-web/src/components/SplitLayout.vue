<script setup lang="ts">
import { computed, ref } from 'vue';
import type { PaneGroup, PaneLayout } from '../composables/usePaneLayout';

defineOptions({ name: 'SplitLayout' });

const props = defineProps<{ layout: PaneLayout }>();
const emit = defineEmits<{ resize: [splitId: string, sizes: number[]] }>();
defineSlots<{ group(props: { group: PaneGroup }): unknown }>();

const rootRef = ref<HTMLElement | null>(null);

const gridStyle = computed(() => {
  if (props.layout.type === 'group') return {};
  const tracks = props.layout.sizes.map((size) => `${Math.max(0.1, size)}fr`).join(' 6px ');
  return props.layout.dir === 'row'
    ? { gridTemplateColumns: tracks }
    : { gridTemplateRows: tracks };
});

function childGridIndex(index: number): number {
  return index * 2 + 1;
}

function handleGridIndex(index: number): number {
  return index * 2 + 2;
}

function startResize(event: MouseEvent, index: number): void {
  if (props.layout.type === 'group' || !rootRef.value) return;
  event.preventDefault();
  const split = props.layout;
  const start = split.dir === 'row' ? event.clientX : event.clientY;
  const rect = rootRef.value.getBoundingClientRect();
  const totalPx = split.dir === 'row' ? rect.width : rect.height;
  const initial = [...split.sizes];
  const totalUnits = initial.reduce((sum, size) => sum + size, 0);
  const unitsPerPx = totalPx > 0 ? totalUnits / totalPx : 1;

  function onMove(move: MouseEvent): void {
    const current = split.dir === 'row' ? move.clientX : move.clientY;
    const delta = (current - start) * unitsPerPx;
    const next = [...initial];
    const left = Math.max(0.2, (initial[index] ?? 1) + delta);
    const right = Math.max(0.2, (initial[index + 1] ?? 1) - delta);
    next[index] = left;
    next[index + 1] = right;
    emit('resize', split.id, next);
  }

  function onUp(): void {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}
</script>

<template>
  <div v-if="layout.type === 'group'" class="split-group">
    <slot name="group" :group="layout" />
  </div>
  <div v-else ref="rootRef" class="split-layout" :class="layout.dir" :style="gridStyle">
    <template v-for="(child, index) in layout.children" :key="child.id">
      <SplitLayout
        class="split-child"
        :style="{ gridColumn: layout.dir === 'row' ? childGridIndex(index) : undefined, gridRow: layout.dir === 'col' ? childGridIndex(index) : undefined }"
        :layout="child"
        @resize="(splitId, sizes) => emit('resize', splitId, sizes)"
      >
        <template #group="{ group: childGroup }">
          <slot name="group" :group="childGroup" />
        </template>
      </SplitLayout>
      <button
        v-if="index < layout.children.length - 1"
        class="split-handle"
        :class="layout.dir"
        type="button"
        :style="{ gridColumn: layout.dir === 'row' ? handleGridIndex(index) : undefined, gridRow: layout.dir === 'col' ? handleGridIndex(index) : undefined }"
        @mousedown="startResize($event, index)"
      />
    </template>
  </div>
</template>

<style scoped>
.split-layout {
  min-width: 0;
  min-height: 0;
  height: 100%;
  display: grid;
}
.split-group {
  min-width: 0;
  min-height: 0;
  height: 100%;
}
.split-child {
  min-width: 0;
  min-height: 0;
}
.split-handle {
  border: none;
  padding: 0;
  background: var(--line);
  cursor: col-resize;
}
.split-handle.col {
  cursor: row-resize;
}
.split-handle:hover {
  background: var(--bd);
}
</style>
