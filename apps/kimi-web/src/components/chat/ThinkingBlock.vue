<!-- apps/kimi-web/src/components/chat/ThinkingBlock.vue -->
<!-- 9e97773-style presentation: while this block is streaming it shows a live
     5-line scrolling window; when the stream moves past it the window folds
     into a one-paragraph teaser (the LAST paragraph of the thinking text).
     There is NO inline expand any more — clicking anywhere on the block emits
     `open`, and the parent shows the full text in the right-side panel. -->
<script setup lang="ts">
import { computed, onMounted, ref, watch, nextTick } from 'vue';

const props = withDefaults(
  defineProps<{
    text: string;
    mobile?: boolean;
    streaming?: boolean;
    foldable?: boolean;
  }>(),
  { mobile: false, streaming: false, foldable: true },
);

const emit = defineEmits<{
  /** Show the full thinking text (right-side panel — App's shared slot). */
  open: [];
}>();

// Live window while streaming, teaser afterwards. The 0.25s grid transition
// between the two states (fa8b305) plays on the class flip.
const paragraphs = computed(() =>
  props.text
    .split(/\n{2,}/)
    .filter((p) => p.trim().length > 0),
);

/** Single-paragraph thinking has nothing to fold — show it straight. */
const isFoldable = computed(() => props.foldable && paragraphs.value.length > 1);
const open = computed(() => props.streaming || !isFoldable.value);

/** Last non-empty paragraph, shown as the collapsed teaser. */
const teaser = computed(() => paragraphs.value.pop() ?? '');

const bodyEl = ref<HTMLElement | null>(null);

// On mount, a streaming block must land on its LATEST line. After a page refresh
// mid-stream the whole thinking text is present at once with scrollTop 0, so the
// "already at bottom?" check below would otherwise leave the live window parked
// at the top. A static/historical block is left at its start (we don't pin it).
onMounted(() => {
  if (!props.streaming) return;
  const el = bodyEl.value;
  if (el) el.scrollTop = el.scrollHeight;
});

watch(
  () => props.text,
  () => {
    const el = bodyEl.value;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (!atBottom) return;
    void nextTick(() => {
      if (bodyEl.value) bodyEl.value.scrollTop = bodyEl.value.scrollHeight;
    });
  },
  { immediate: true },
);
</script>

<template>
  <div class="think" :class="{ mob: mobile }">
    <!-- Foldable: live window above, last-paragraph teaser below; click opens
         the full text in the right-side panel -->
    <template v-if="isFoldable">
      <div class="tc-wrap" :class="{ 'is-collapsed': !open }" @click="emit('open')">
        <div class="tc-anim">
          <pre ref="bodyEl" class="tc">{{ text }}</pre>
        </div>
        <div class="prev-anim">
          <span class="prev">{{ teaser }}</span>
        </div>
      </div>
    </template>
    <!-- Single-paragraph or explicitly non-foldable: always show full content -->
    <pre v-else ref="bodyEl" class="tc">{{ text }}</pre>
  </div>
</template>

<style scoped>
.think {
  margin: 0;
}

.tc-wrap {
  display: grid;
  grid-template-rows: 1fr 0fr;
  transition: grid-template-rows var(--duration-slow) var(--ease-out);
  cursor: pointer;
}
.tc-wrap.is-collapsed {
  grid-template-rows: 0fr 1fr;
}
.tc-anim,
.prev-anim {
  overflow: hidden;
}

/* Hover hints clickability (opens the full text in the side panel) */
.tc-wrap.is-collapsed:hover .prev {
  color: var(--color-text);
}
.tc-wrap:not(.is-collapsed):hover .tc {
  color: var(--color-text-muted);
}

.prev {
  color: var(--color-text-faint);
  font: var(--text-base)/var(--leading-relaxed) var(--font-mono);
  white-space: pre-wrap;
  word-break: break-word;
  display: block;
}

.tc {
  font: var(--text-base)/var(--leading-relaxed) var(--font-mono);
  color: var(--color-text-muted);
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  max-height: calc(var(--leading-relaxed) * 1em * 5);
  overflow-y: auto;
}

/* ---- Mobile tweaks ---- */
.mob {
  margin: 0;
}
.mob .tc {
  color: var(--color-text-faint);
  line-height: var(--leading-normal);
  max-height: calc(var(--leading-normal) * 1em * 5);
}
.mob .prev {
  color: var(--color-text-faint);
  line-height: var(--leading-normal);
}
</style>
