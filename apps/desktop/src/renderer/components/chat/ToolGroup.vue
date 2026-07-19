<!-- apps/kimi-web/src/components/chat/ToolGroup.vue -->
<!-- A homogeneous batch of consecutive same-kind tool calls, rendered as ONE
     quiet caption row that expands into the individual lines. The caption
     shares the thinking row's language exactly: a borderless faint text row
     (text-colour hover only, no wash), one whole-row <button>, chevron
     rotating 90°. It leads with the batch's own glyph (the icon its rows
     carry) — status rides on the glyph: breathing while running, danger on
     failure. While any call is still running the group starts expanded so
     live progress is visible; once every call settles it folds itself back
     to the caption — even if the user expanded it mid-run (the thinking
     block's vocabulary). Expanded rows stack directly on the shared rhythm,
     no dividers. -->
<script setup lang="ts">
import { computed, inject, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import ToolCall from './ToolCall.vue';
import { toolStackKey } from '../chatTurnRendering';
import type { ToolStackItem } from '../chatTurnRendering';
import type { FilePreviewRequest, ToolMedia } from '../../types';
import { normalizeToolName } from '../../lib/toolMeta';
import { Icon } from '@moonshot-ai/web-ui';
import { formatCountNumber } from '@moonshot-ai/web-i18n';

const props = withDefaults(
  defineProps<{
    tools: ToolStackItem[];
    mobile?: boolean;
  }>(),
  { mobile: false },
);

const emit = defineEmits<{
  openMedia: [media: ToolMedia];
  openFile: [target: FilePreviewRequest];
  openAgent: [toolCallId: string];
}>();

const count = computed(() => props.tools.length);
const aggregateStatus = computed<'running' | 'error' | 'done'>(() => {
  if (props.tools.some((t) => t.tool.status === 'running')) return 'running';
  if (props.tools.some((t) => t.tool.status === 'error')) return 'error';
  return 'done';
});
const { t } = useI18n();

// Groups are homogeneous by construction (assistantRenderBlocks only merges
// consecutive calls of one kind), so the caption can narrate the batch as a
// natural sentence — "Running 2 commands" live, "Ran 2 commands" once
// settled; the verb carries the tense, so the meta label only stays for the
// failure case. Kinds outside the groupable set never reach here, but the
// untyped fallback keeps the component safe against hand-built stacks.
const TYPED_KINDS = new Set(['read', 'grep', 'search', 'glob', 'ls', 'web_fetch', 'bash']);
const groupKind = computed(() => normalizeToolName(props.tools[0]?.tool.name ?? ''));
const isTyped = computed(() => TYPED_KINDS.has(groupKind.value));

// The caption leads with the batch's own glyph — the same icon the expanded
// rows carry — so a command batch and a read batch are distinguishable at a
// scan, without reading. Status rides on the glyph: faint when settled,
// breathing while running, danger on failure.
const GROUP_ICON: Record<string, string> = {
  read: 'file-text',
  bash: 'terminal',
  grep: 'search',
  search: 'search',
  glob: 'tree-view',
  ls: 'list',
  web_fetch: 'globe',
};
const groupIcon = computed(() => GROUP_ICON[groupKind.value] ?? 'tool');

const countTitle = computed(() => {
  if (isTyped.value) {
    const tense = aggregateStatus.value === 'running' ? 'doing' : 'done';
    return t(`tools.group.typed.${groupKind.value}.${tense}`, { count: count.value });
  }
  const key = count.value === 1 ? 'tools.group.countOne' : 'tools.group.countOther';
  return t(key, { number: formatCountNumber(count.value, t) });
});

const statusLabel = computed(() => {
  switch (aggregateStatus.value) {
    case 'running':
      return t('tools.group.running');
    case 'error':
      return t('tools.group.error');
    default:
      return t('tools.group.done');
  }
});

// A typed caption's verb already carries the outcome; only a failure (and the
// untyped fallback, whose title carries no tense) keeps the meta suffix.
const showMeta = computed(() => !isTyped.value || aggregateStatus.value === 'error');

// The default applies only at mount; manual toggles stick.
const open = ref(aggregateStatus.value === 'running');

const pinScroll = inject<(el: HTMLElement, ms?: number) => void>('pinScroll', () => {});
const headEl = ref<HTMLElement | null>(null);

// Settle quiet: once every call in the group has finished, fold the run back
// to its caption — even if the user expanded it mid-run (the thinking block's
// vocabulary: it folds back when the stream moves past it). Pin the head so
// the collapsing body doesn't yank the viewport.
watch(aggregateStatus, (status, prev) => {
  if (prev === 'running' && status !== 'running') {
    open.value = false;
    const el = headEl.value;
    if (el) nextTick(() => pinScroll(el));
    return;
  }
  // Streaming can append another same-kind call to an already-settled group
  // (the key stays on the first source index, so this instance persists):
  // reopen on the settled → running transition or the new live call stays
  // hidden inside the folded caption.
  if (prev !== 'running' && status === 'running') {
    open.value = true;
  }
});

function toggle(): void {
  open.value = !open.value;
  const el = headEl.value;
  if (el) nextTick(() => pinScroll(el));
}
</script>

<template>
  <div class="tool-group" :class="{ open }">
    <button ref="headEl" class="tg-head" type="button" :aria-expanded="open" @click="toggle">
      <span
        class="tg-kind"
        :class="{ run: aggregateStatus === 'running', err: aggregateStatus === 'error' }"
        role="status"
        :aria-label="aggregateStatus"
      >
        <Icon :name="groupIcon" size="sm" aria-hidden="true" />
      </span>
      <span class="tg-title">{{ countTitle }}</span>
      <span v-if="showMeta" class="tg-meta">· {{ statusLabel }}</span>
      <Icon class="tg-car" name="chevron-right" size="sm" aria-hidden="true" />
    </button>
    <div class="tg-body" :class="{ open }" :inert="!open">
      <div class="tg-body-inner">
        <ToolCall
          v-for="item in tools"
          :key="toolStackKey(item)"
          :tool="item.tool"
          :mobile="mobile"
          @open-media="emit('openMedia', $event)"
          @open-file="emit('openFile', $event)"
          @open-agent="emit('openAgent', $event)"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool-group {
  display: flex;
  flex-direction: column;
}

/* Caption row — the thinking row's exact language: borderless faint text row,
   text-colour hover only (no wash), 4px rhythm, status dot pinned to the
   message stream's left edge. */
.tg-head {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  width: 100%;
  padding: var(--space-1) 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-faint);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  /* Same as the thinking row: decouple from the reading line-height so the
     text em box and the dot centre exactly. */
  line-height: 1;
  text-align: left;
  cursor: pointer;
  user-select: none;
  transition: color var(--duration-base) var(--ease-out);
}
.tg-head:hover {
  color: var(--color-text);
}
.tg-head:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--color-accent-soft);
}

.tg-kind {
  display: inline-flex;
  align-items: center;
  flex: none;
  color: var(--color-text-faint);
}
.tg-kind.err {
  color: var(--color-danger);
}
/* While any call is still running the glyph breathes (opacity only, the
   thinking label's vocabulary — the design system bans gradient shimmer);
   reduced-motion keeps it static. */
.tg-kind.run {
  color: var(--color-text-muted);
  animation: tg-breathe 1.6s var(--ease-in-out) infinite;
}
@keyframes tg-breathe {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}
@media (prefers-reduced-motion: reduce) {
  .tg-kind.run {
    animation: none;
  }
}
.tg-title {
  font-weight: var(--weight-medium);
}
/* Metadata stays faint even on hover (same vocabulary as the thinking row's
   elapsed seconds). */
.tg-meta {
  color: var(--color-text-faint);
  font-weight: var(--weight-regular);
}
.tg-car {
  /* Disclosure chevron hugs the caption text (thinking-row style) — never
     pushed to the far right edge. */
  color: var(--color-text-faint);
  flex: none;
  transition: transform var(--duration-base) var(--ease-out);
}
.tool-group.open .tg-car {
  transform: rotate(90deg);
}

/* Expanded rows: grid-rows animation; lines stack directly on the shared
   rhythm — no dividers. */
.tg-body {
  display: grid;
  grid-template-rows: minmax(0, 0fr);
  overflow: hidden;
  transition: grid-template-rows var(--duration-base) var(--ease-out);
}
.tg-body.open {
  grid-template-rows: minmax(0, 1fr);
}
.tg-body-inner {
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
</style>
