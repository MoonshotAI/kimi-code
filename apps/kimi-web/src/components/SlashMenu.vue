<!-- apps/kimi-web/src/components/SlashMenu.vue -->
<!-- Popup list of slash commands shown above the Composer textarea. -->
<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { SlashCommand } from '../lib/slashCommands';

const { t } = useI18n();

const props = defineProps<{
  items: SlashCommand[];
  activeIndex: number;
}>();

const emit = defineEmits<{
  select: [item: SlashCommand];
  hover: [index: number];
}>();

const itemRefs = ref<HTMLElement[]>([]);

watch(
  () => props.activeIndex,
  (idx) => {
    itemRefs.value[idx]?.scrollIntoView({ block: 'nearest' });
  },
);
</script>

<template>
  <div v-if="items.length > 0" class="slash-menu" role="listbox">
    <div
      v-for="(item, i) in items"
      ref="itemRefs"
      :key="`${item.name}-${i}`"
      class="slash-item"
      :class="{ active: i === props.activeIndex }"
      role="option"
      :aria-selected="i === props.activeIndex"
      @mouseenter="emit('hover', i)"
      @mousedown.prevent="emit('select', item)"
    >
      <span class="slash-name">{{ item.name }}</span>
      <span class="slash-desc">{{ item.isSkill ? item.desc : t(item.desc) }}</span>
    </div>
  </div>
</template>

<style scoped>
.slash-menu {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 0;
  right: 0;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  z-index: 100;
  max-height: 240px;
  overflow-y: auto;
}

.slash-item {
  display: grid;
  grid-template-columns: minmax(90px, 32%) minmax(0, 1fr);
  align-items: start;
  gap: 10px;
  padding: 5px 12px;
  cursor: pointer;
  font-family: var(--mono);
  font-size: var(--ui-font-size);
  border-bottom: 1px solid var(--line2);
}

.slash-item:last-child {
  border-bottom: none;
}

.slash-item:hover,
.slash-item.active {
  background: var(--soft);
}

.slash-name {
  color: var(--blue);
  font-weight: 600;
  min-width: 0;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.slash-desc {
  color: var(--dim);
  font-size: calc(var(--ui-font-size) - 2.5px);
  min-width: 0;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

@media (max-width: 520px) {
  .slash-item {
    grid-template-columns: minmax(0, 1fr);
    gap: 2px;
  }
}
</style>
