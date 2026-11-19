<script setup lang="ts">
import { onUnmounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { openSheetCount } from '@moonshot-ai/app-ui';

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    title?: string;
    closeOnEsc?: boolean;
  }>(),
  { title: '', closeOnEsc: true },
);

const emit = defineEmits<{
  'update:modelValue': [open: boolean];
  close: [];
}>();

function close(): void {
  emit('update:modelValue', false);
  emit('close');
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && props.closeOnEsc) close();
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) openSheetCount.value += 1;
    else openSheetCount.value = Math.max(0, openSheetCount.value - 1);
    if (typeof document === 'undefined') return;
    if (open) document.addEventListener('keydown', onKeydown);
    else document.removeEventListener('keydown', onKeydown);
  },
  { immediate: true },
);

onUnmounted(() => {
  if (props.modelValue) openSheetCount.value = Math.max(0, openSheetCount.value - 1);
  if (typeof document !== 'undefined') document.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <Transition name="sheet">
    <div v-if="modelValue" class="sheet-root">
      <div class="sheet-scrim" @click="close" />
      <div class="sheet-panel" role="dialog" :aria-label="title || t('mobile.sheetLabel')">
        <button
          type="button"
          class="sheet-grab"
          :aria-label="t('mobile.closeSheet')"
          @click="close"
        />
        <div v-if="title" class="sheet-head">
          <span class="sheet-title">{{ title }}</span>
        </div>
        <div class="sheet-body">
          <slot />
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.sheet-root {
  position: fixed;
  inset: 0;
  z-index: var(--z-overlay);
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
}

.sheet-scrim {
  position: absolute;
  inset: 0;
  background: rgba(13, 17, 23, 0.45);
}

.sheet-panel {
  position: relative;
  background: var(--color-surface-raised);
  border: var(--p-hairline) solid var(--color-line);
  border-bottom: none;
  border-radius: var(--radius-xl) var(--radius-xl) 0 0;
  box-shadow: var(--shadow-xl);
  max-height: calc(var(--app-height, 100dvh) * 0.86);
  display: flex;
  flex-direction: column;
  min-height: 0;
  font-family: var(--font-ui);
  color: var(--color-text);
}

.sheet-grab {
  flex: none;
  align-self: center;
  width: 56px;
  height: 18px;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  position: relative;
  margin-top: 4px;
}
.sheet-grab::after {
  content: "";
  position: absolute;
  left: 50%;
  top: 7px;
  transform: translateX(-50%);
  width: 38px;
  height: 5px;
  border-radius: var(--radius-full);
  background: var(--color-line);
}

.sheet-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 16px 10px;
}
.sheet-title {
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  color: var(--color-text);
}

.sheet-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding-bottom: max(16px, var(--safe-bottom));
}

.sheet-enter-active,
.sheet-leave-active {
  transition: opacity var(--duration-slow) var(--ease-out);
}
.sheet-enter-active .sheet-panel,
.sheet-leave-active .sheet-panel {
  transition: transform var(--duration-slow) var(--ease-out);
}
.sheet-enter-from,
.sheet-leave-to {
  opacity: 0;
}
.sheet-enter-from .sheet-panel,
.sheet-leave-to .sheet-panel {
  transform: translateY(102%);
}
</style>
