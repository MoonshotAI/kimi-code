<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import ResizeHandle from './ResizeHandle.vue';
import type { FileTreePosition } from './composables/useFileTreePosition';

const { t } = useI18n();

withDefaults(defineProps<{ position?: FileTreePosition }>(), { position: 'right' });

const TREE_WIDTH_KEY = 'kimi-web.file-tree-width';

function cssWidthToken(name: string, fallback: number): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

const DEFAULT_WIDTH = cssWidthToken('--file-tree-panel-w', 224);
const MIN_WIDTH = cssWidthToken('--file-tree-panel-min-w', 160);
const MAX_WIDTH = cssWidthToken('--file-tree-panel-max-w', 400);

const width = ref(DEFAULT_WIDTH);
</script>

<template>
  <aside class="fts-frame" :class="`fts-frame--${position}`" :style="{ width: `${width}px` }">
    <ResizeHandle
      class="fts-frame-resize"
      :storage-key="TREE_WIDTH_KEY"
      :default-width="DEFAULT_WIDTH"
      :min="MIN_WIDTH"
      :max="MAX_WIDTH"
      :reverse="position === 'right'"
      :aria-label="t('fileTree.resize')"
      @update:width="width = $event"
    />
    <div class="fts-frame-body">
      <slot />
    </div>
  </aside>
</template>

<style scoped>
.fts-frame {
  position: relative;
  flex: none;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.fts-frame--right {
  border-left: var(--p-hairline) solid var(--color-line);
}

.fts-frame--left {
  border-right: var(--p-hairline) solid var(--color-line);
}

.fts-frame-resize {
  position: absolute;
  top: 0;
  bottom: 0;
}

.fts-frame--right > .fts-frame-resize {
  left: calc(-1 * var(--space-1));
}

.fts-frame--left > .fts-frame-resize {
  right: calc(-1 * var(--space-1));
}

.fts-frame-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
</style>
