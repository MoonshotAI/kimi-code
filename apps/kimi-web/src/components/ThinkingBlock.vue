<!-- apps/kimi-web/src/components/ThinkingBlock.vue -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';

const props = withDefaults(
  defineProps<{
    text: string;
    /**
     * Mobile / Codex style: a small gray clickable header with a rotating
     * chevron + plain gray body text, no left quote-bar, no italics. Defaults
     * to open (matching the prototype). Desktop keeps the collapsed line style.
     */
    mobile?: boolean;
  }>(),
  { mobile: false },
);

const { t } = useI18n();

// Mobile starts open (prototype shows the reasoning expanded); desktop collapsed.
const open = ref(props.mobile);

function toggle() {
  open.value = !open.value;
}

/** First line or up to ~80 chars for the collapsed summary (desktop only) */
const preview = computed(() => {
  const firstLine = props.text.split('\n')[0] ?? '';
  if (firstLine.length > 72) return firstLine.slice(0, 72) + '…';
  return firstLine;
});
</script>

<template>
  <!-- Mobile / Codex style: gray collapsible header + plain gray body -->
  <div v-if="mobile" class="think mthink" :class="{ open }">
    <button class="h" @click="toggle" :aria-expanded="open">
      <span class="cv">▸</span>
      <span class="hl">{{ t('thinking.label') }}</span>
    </button>
    <div class="c">{{ text }}</div>
  </div>

  <!-- Desktop: collapsed italic line with inline preview -->
  <div v-else class="think" :class="{ open }">
    <button class="th" @click="toggle" :aria-expanded="open">
      <span class="car">{{ open ? '▾' : '▸' }}</span>
      <span class="label">{{ t('thinking.label') }}</span>
      <span v-if="!open" class="prev">{{ preview }}</span>
    </button>
    <div v-if="open" class="tb">
      <pre class="tc">{{ text }}</pre>
    </div>
  </div>
</template>

<style scoped>
.think {
  margin: 4px 0 6px 0;
}

.th {
  display: flex;
  align-items: baseline;
  gap: 7px;
  width: 100%;
  background: none;
  border: none;
  padding: 4px 8px;
  cursor: pointer;
  color: var(--dim);
  font-size: 12px;
  font-family: var(--mono);
  font-style: italic;
  text-align: left;
}

.th:hover {
  color: var(--text);
}

.car {
  color: var(--faint);
  font-style: normal;
  flex: none;
}

.label {
  color: var(--muted);
  font-weight: 600;
  font-style: normal;
  flex: none;
}

.prev {
  color: var(--faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.tb {
  padding: 0 8px 6px 8px;
}

.tc {
  font-family: var(--mono);
  font-size: 11.5px;
  font-style: italic;
  color: var(--muted);
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  line-height: 1.7;
}

/* ===================== Mobile / Codex style ===================== */
.mthink {
  margin: 0 0 2px 0;
}
.mthink .h {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  user-select: none;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--muted);
  text-align: left;
}
.mthink .h .cv {
  flex: none;
  font-size: 9px;
  color: var(--faint);
  transition: transform 0.15s;
}
.mthink.open .h .cv {
  transform: rotate(90deg);
}
.mthink .hl {
  color: var(--muted);
}
.mthink .c {
  display: none;
  margin-top: 6px;
  font-family: var(--mono);
  font-size: 12.5px;
  color: var(--faint);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.mthink.open .c {
  display: block;
}
</style>
