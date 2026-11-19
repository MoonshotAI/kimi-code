<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { copyTextToClipboard } from '@moonshot-ai/app-core/lib';
import { Icon, IconButton } from '@moonshot-ai/app-ui';

const props = withDefaults(
  defineProps<{
    title?: string;
    meta?: string;
    copyText?: string;
    flush?: boolean;
    scroll?: boolean;
    compact?: boolean;
  }>(),
  { title: '', meta: '', copyText: '', flush: false, scroll: false, compact: false },
);

const { t } = useI18n();

const copied = ref(false);
let resetTimer: ReturnType<typeof setTimeout> | undefined;

async function copy(): Promise<void> {
  if (!props.copyText || !(await copyTextToClipboard(props.copyText))) return;
  copied.value = true;
  clearTimeout(resetTimer);
  resetTimer = setTimeout(() => (copied.value = false), 1500);
}
</script>

<template>
  <div class="tp" :class="{ flush, compact }">
    <div v-if="title || meta || copyText || $slots.head || $slots.actions" class="tp-head">
      <span class="tp-titles">
        <slot name="head">
          <span v-if="title" class="tp-title">{{ title }}</span>
          <span v-if="meta" class="tp-meta">{{ meta }}</span>
        </slot>
      </span>
      <slot name="actions" />
      <IconButton
        v-if="copyText"
        size="sm"
        :label="t('common.copy')"
        :tooltip="t('common.copy')"
        @click.stop="copy"
      >
        <Icon :name="copied ? 'check' : 'copy'" size="md" />
      </IconButton>
    </div>
    <div class="tp-body" :class="{ scroll }">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.tp {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  min-width: 0;
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--color-fill-1);
  overflow: clip;
}
.tp.flush {
  gap: 0;
  padding: 0;
}

.tp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  min-width: 0;
}
.tp.flush .tp-head {
  padding: var(--space-2) var(--space-3);
}
.tp.flush.compact .tp-head {
  --tp-glyph-inset: calc((var(--icon-button-sm) - var(--p-ic-md)) / 2);
  gap: calc(var(--space-1-5) - var(--tp-glyph-inset));
  padding: var(--space-1-5) var(--space-1-5) var(--space-1-5) var(--space-3);
}

.tp-titles {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  font-family: var(--font-ui);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
}
.tp.compact .tp-titles {
  font-size: var(--text-sm);
}
.tp-title {
  color: var(--color-text);
  flex: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tp-meta {
  color: var(--color-text-muted);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tp-body {
  min-width: 0;
  min-height: 0;
}
.tp-body.scroll {
  max-height: calc(13 * 1lh);
  overflow: auto;
  overscroll-behavior: contain;
}

.tp-body :deep(.hl-code) {
  font-size: var(--content-font-size);
  line-height: 1.571;
}
</style>
