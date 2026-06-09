<!-- apps/kimi-web/src/components/SlashMenu.vue -->
<!-- Popup list of slash commands shown above the Composer textarea. -->
<script setup lang="ts">
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
</script>

<template>
  <div v-if="items.length > 0" class="slash-menu" role="listbox">
    <div
      v-for="(item, i) in items"
      :key="item.name"
      class="slash-item"
      :class="{ active: i === props.activeIndex }"
      role="option"
      :aria-selected="i === props.activeIndex"
      @mouseenter="emit('hover', i)"
      @mousedown.prevent="emit('select', item)"
    >
      <span class="slash-name">{{ item.name }}</span>
      <span class="slash-desc">{{ t(item.desc) }}</span>
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
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 5px 12px;
  cursor: pointer;
  font-family: var(--mono);
  font-size: 14px;
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
  min-width: 90px;
  flex-shrink: 0;
}

.slash-desc {
  color: var(--dim);
  font-size: 11.5px;
}
</style>
