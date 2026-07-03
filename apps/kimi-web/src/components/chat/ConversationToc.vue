<!-- apps/kimi-web/src/components/chat/ConversationToc.vue -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
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
  /** Query currently owning the viewport middle. */
  activeTurnId: string | null;
  mobile?: boolean;
  sessionLoading?: boolean;
}>();

const emit = defineEmits<{
  select: [turnId: string];
}>();

const { t } = useI18n();

// Width the rail needs beside the reading column once its labels are fully
// revealed on hover/focus: 3px bar + 10px gap + 220px label, plus a small
// buffer so the text never kisses the container edge. Kept in sync with the
// `.toc-bar` / `.toc-label` rules below.
const EXPANDED_WIDTH = 240;

const navRef = ref<HTMLElement | null>(null);
// Whether the rail, once expanded, fits within the room to the right of the
// reading column. When it would overflow, we hide the outline entirely rather
// than showing a panel that gets clipped by the container edge.
const fits = ref(true);

let observer: ResizeObserver | null = null;

function measure(): void {
  const nav = navRef.value;
  const parent = nav?.offsetParent as HTMLElement | null;
  if (!nav || !parent) return;
  const navLeft = nav.getBoundingClientRect().left;
  const parentRight = parent.getBoundingClientRect().right;
  fits.value = parentRight - navLeft >= EXPANDED_WIDTH;
}

// The outline is only useful once there is something to navigate, and it never
// shows on mobile or while the session is still loading. `fits` is kept out of
// this computed so the nav stays mounted (and measurable) even when hidden;
// clipping is applied via the `toc-clipped` class instead.
const visible = computed(
  () => !props.mobile && !props.sessionLoading && props.items.length > 1,
);

// The nav is rendered only while `visible` (v-if), so a mount while navRef is
// still null (during sessionLoading, on mobile, or before a second user turn)
// would skip the ResizeObserver setup and leave `fits` at its default `true`.
// Re-initialize whenever the nav is actually rendered so `fits` is measured
// against the real layout instead.
watch(
  visible,
  (isVisible) => {
    observer?.disconnect();
    observer = null;
    if (!isVisible) return;
    void nextTick(() => {
      const nav = navRef.value;
      const parent = nav?.offsetParent as HTMLElement | null;
      if (!nav || !parent) return;
      if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(measure);
        observer.observe(parent);
      }
      measure();
    });
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
});
</script>

<template>
  <!-- Conversation outline: a vertical list of short bars (one per user query),
       vertically centered beside the chat. Hovering the list enlarges the bars
       and reveals each query's title to the right, making rows easy to click. -->
  <nav
    v-if="visible"
    ref="navRef"
    class="conversation-toc"
    :class="{ 'toc-clipped': !fits }"
    :aria-label="t('conversation.toc')"
    :aria-hidden="fits ? undefined : true"
  >
    <div class="toc-scroll">
      <button
        v-for="item in items"
        :key="item.id"
        type="button"
        class="toc-row"
        :class="{ active: activeTurnId === item.id }"
        @click="emit('select', item.id)"
      >
        <span class="toc-bar" />
        <span class="toc-label">{{ item.title }}</span>
      </button>
    </div>
  </nav>
</template>

<style scoped>
.conversation-toc {
  position: absolute;
  z-index: var(--z-sticky);
  top: 50%;
  transform: translateY(-50%);
  left: calc(50% + (var(--read-max) / 2) + 14px);
  display: flex;
  flex-direction: column;
  justify-content: center;
  opacity: 0.5;
  transition: opacity var(--duration-base) var(--ease-out);
}
/* Invisible hover bridge: the collapsed rail is only a few px wide, so this
   extends the hover target on both sides to make the outline easy to open and
   forgiving to stay within. Kept at z-index 0 so it sits behind the rows
   (which are raised to z-index 1) — otherwise the bridge, as a positioned
   pseudo-element, paints above the in-flow rows and swallows their clicks. */
.conversation-toc::before {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: -48px;
  right: -48px;
  z-index: 0;
}
.conversation-toc:hover,
.conversation-toc:focus-within { opacity: 1; }

.toc-scroll {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 8px 0;
  max-height: calc(100vh - 200px);
  overflow-y: auto;
  scrollbar-width: none;
}
.toc-scroll::-webkit-scrollbar { display: none; }

.toc-row {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 18px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
}
.toc-row:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }

.toc-bar {
  flex: none;
  width: 3px;
  height: 14px;
  border-radius: var(--radius-full);
  background: var(--color-accent);
  opacity: 0.3;
  transition:
    opacity var(--duration-fast) var(--ease-out),
    height var(--duration-fast) var(--ease-out);
}
.toc-label {
  display: block;
  max-width: 0;
  overflow: hidden;
  opacity: 0;
  text-overflow: ellipsis;
  transition:
    max-width 220ms var(--ease-out),
    opacity var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}

/* Hover / focus: enlarge bars and reveal labels to the right. */
.conversation-toc:hover .toc-bar,
.conversation-toc:focus-within .toc-bar { height: 18px; opacity: 0.5; }
.conversation-toc:hover .toc-label,
.conversation-toc:focus-within .toc-label { max-width: 220px; opacity: 1; }

.toc-row.active .toc-bar { opacity: 1; height: 18px; }
.toc-row.active .toc-label { color: var(--color-accent); font-weight: var(--weight-medium); }
.toc-row:hover .toc-bar { opacity: 1; }
.toc-row:hover .toc-label { color: var(--color-text); }

/* When there is not enough room to the right of the reading column to reveal
   the labels, the rail is kept mounted (so its position can keep being
   measured) but hidden from view and from pointer/screen-reader interaction. */
.conversation-toc.toc-clipped {
  visibility: hidden;
  pointer-events: none;
}
</style>
