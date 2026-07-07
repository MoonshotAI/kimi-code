<!-- apps/kimi-web/src/components/chat/SlashMenu.vue -->
<!-- Popup list of slash commands shown above the Composer textarea. -->
<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { SlashCommand } from '../../lib/slashCommands';

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
      :ref="(el) => { if (el) itemRefs[i] = el as HTMLElement }"
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
/* `[role="listbox"]` raises specificity (0,3,0) so the redesign's surface +
   shadow-md win over any global menu styles. */
.slash-menu[role="listbox"] {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 0;
  right: 0;
  padding: var(--space-1);
  background: var(--color-surface-raised);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  z-index: var(--z-dropdown);
  max-height: 240px;
  overflow-y: auto;
}

.slash-item {
  display: grid;
  grid-template-columns: minmax(90px, 32%) minmax(0, 1fr);
  align-items: start;
  gap: 10px;
  padding: 6px 10px;
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  border-radius: var(--radius-sm);
}

.slash-item:hover {
  background: var(--color-surface-sunken);
}
.slash-item.active {
  background: var(--color-accent-soft);
}
.slash-item.active .slash-name {
  color: var(--color-accent-hover);
}

.slash-name {
  color: var(--color-accent);
  font-weight: 500;
  min-width: 0;
  line-height: var(--leading-normal);
  overflow-wrap: anywhere;
}

.slash-desc {
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  min-width: 0;
  line-height: var(--leading-normal);
  overflow-wrap: anywhere;
}

@media (max-width: 520px) {
  .slash-item {
    grid-template-columns: minmax(0, 1fr);
    gap: 2px;
  }
}

/* ---- Menu surface defaults ---- */
.slash-menu { border-radius: var(--radius-lg); box-shadow: var(--sh); }
.slash-desc { font-family: var(--sans); }
</style>
