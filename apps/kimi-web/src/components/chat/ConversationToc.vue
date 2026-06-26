<!-- apps/kimi-web/src/components/chat/ConversationToc.vue -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ChatTurn } from '../../types';

export interface ConversationTocItem {
  id: string;
  role: ChatTurn['role'];
  no: number;
  title: string;
}

const props = defineProps<{
  items: ConversationTocItem[];
  /** Proportional bubble heights, parallel to `items`. */
  metrics: { id: string; height: number }[];
  /** Turn currently closest to the viewport middle. */
  activeTurnId: string | null;
  /** Viewport indicator position/size within the track. */
  viewport: { top: number; height: number } | null;
  mobile?: boolean;
  sessionLoading?: boolean;
}>();

const emit = defineEmits<{
  select: [turnId: string];
}>();

const { t } = useI18n();

// The outline is only useful once there is something to navigate, and it never
// shows on mobile or while the session is still loading.
const visible = computed(
  () => !props.mobile && !props.sessionLoading && props.items.length > 1,
);

const tooltip = ref<{ visible: boolean; text: string; top: number }>({
  visible: false,
  text: '',
  top: 0,
});

function showTooltip(text: string, event: MouseEvent): void {
  const target = event.currentTarget as HTMLElement | null;
  if (!target) return;
  tooltip.value = { visible: true, text, top: target.offsetTop };
}

function hideTooltip(): void {
  tooltip.value.visible = false;
}
</script>

<template>
  <!-- Beta conversation outline: right edge, proportional bubbles, viewport indicator, hover tooltip. -->
  <nav
    v-if="visible"
    class="conversation-toc"
    :aria-label="t('conversation.toc')"
  >
    <div class="toc-track">
      <button
        v-for="(item, index) in items"
        :key="item.id"
        type="button"
        class="toc-bubble"
        :class="[item.role, { active: activeTurnId === item.id }]"
        :style="{ height: metrics[index]?.height + 'px' }"
        :aria-label="`#${item.no} ${item.title}`"
        @mouseenter="(e: MouseEvent) => showTooltip(item.title, e)"
        @mouseleave="hideTooltip"
        @click="emit('select', item.id)"
      >
        <span class="toc-no">{{ item.no }}</span>
      </button>
      <div
        v-if="viewport"
        class="toc-viewport"
        :style="{ top: viewport.top + 'px', height: viewport.height + 'px' }"
      />
    </div>
    <Transition name="toc-tip">
      <div
        v-show="tooltip.visible"
        class="toc-tooltip"
        :style="{ top: tooltip.top + 'px' }"
      >
        {{ tooltip.text }}
      </div>
    </Transition>
  </nav>
</template>

<style scoped>
.conversation-toc {
  position: absolute;
  z-index: 8;
  display: flex;
  flex-direction: column;
  padding: 0;
  top: 86px;
  bottom: auto;
  left: calc(50% + (var(--read-max) / 2) + 8px);
  width: 46px;
  max-height: calc(100% - 86px - 130px);
  opacity: 0.45;
  transition: opacity 0.18s ease;
}
.conversation-toc:hover {
  opacity: 1;
}
.toc-track {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: center;
  padding: 6px 4px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: none;
  max-height: 100%;
  position: relative;
}
.toc-track::-webkit-scrollbar {
  display: none;
}
.toc-bubble {
  appearance: none;
  position: relative;
  flex-shrink: 0;
  border: 0;
  padding: 0;
  width: 34px;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  opacity: 0.85;
  transition: opacity 0.14s ease, transform 0.14s ease, box-shadow 0.14s ease;
}
.toc-bubble.active {
  opacity: 1;
}
.toc-bubble:hover,
.toc-bubble:focus-visible {
  opacity: 1;
  transform: translateX(2px) scale(1.05);
  outline: none;
}
.toc-bubble.user {
  background: var(--blue);
  box-shadow: none;
}
.toc-bubble.assistant {
  background: var(--panel2);
  box-shadow: inset 0 0 0 1px var(--line);
}
.toc-bubble.compaction {
  height: 10px;
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--faint);
  border-radius: 999px;
}
.toc-bubble.active::after {
  content: '';
  position: absolute;
  inset: -2px;
  border: 2px solid var(--blue);
  border-radius: 10px;
  pointer-events: none;
  opacity: 0.35;
}
.toc-no {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
.toc-viewport {
  position: absolute;
  left: 0;
  right: 0;
  background: color-mix(in srgb, var(--blue) 10%, transparent);
  pointer-events: none;
  border-radius: 4px;
  z-index: 0;
}
.toc-tooltip {
  position: absolute;
  right: calc(100% + 8px);
  top: 0;
  z-index: 20;
  max-width: 240px;
  padding: 6px 10px;
  background: var(--bg);
  color: var(--ink);
  border: 1px solid var(--line);
  border-radius: 8px;
  font-size: var(--ui-font-size-xs);
  line-height: 1.45;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
}
.toc-tooltip::before {
  content: '';
  position: absolute;
  left: auto;
  right: -5px;
  top: 10px;
  border-width: 5px 0 5px 5px;
  border-style: solid;
  border-color: transparent transparent transparent var(--bg);
}
.toc-tip-enter-active,
.toc-tip-leave-active {
  transition: opacity 0.12s ease, transform 0.12s ease;
}
.toc-tip-enter-from,
.toc-tip-leave-to {
  opacity: 0;
  transform: translateX(4px);
}
@container (max-width: 920px) {
  .conversation-toc {
    display: none;
  }
}
</style>
