<!-- apps/kimi-web/src/components/BottomSheet.vue -->
<!-- Reusable mobile bottom sheet: a fading scrim + a panel that slides up from -->
<!-- the bottom (rounded top, grab handle). v-model controls open state; tapping -->
<!-- the scrim or the grab handle closes it. Terminal Pro styling, no emoji. -->
<script setup lang="ts">
import { onUnmounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    /** Open state (use with v-model). */
    modelValue: boolean;
    /** Optional sheet title shown in the header strip. */
    title?: string;
  }>(),
  { title: '' },
);

const emit = defineEmits<{
  'update:modelValue': [open: boolean];
  close: [];
}>();

function close(): void {
  emit('update:modelValue', false);
  emit('close');
}

// Close on Escape while open (desktop keyboard / test convenience).
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') close();
}

watch(
  () => props.modelValue,
  (open) => {
    if (typeof document === 'undefined') return;
    if (open) document.addEventListener('keydown', onKeydown);
    else document.removeEventListener('keydown', onKeydown);
  },
  { immediate: true },
);

onUnmounted(() => {
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
  z-index: 300;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
}

.sheet-scrim {
  position: absolute;
  inset: 0;
  background: rgba(18, 22, 30, 0.4);
}

.sheet-panel {
  position: relative;
  background: var(--bg);
  border-radius: 20px 20px 0 0;
  box-shadow: 0 -12px 40px rgba(18, 22, 30, 0.18);
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  min-height: 0;
  font-family: var(--mono);
}

/* Grab handle — also a tap target to close. */
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
  border-radius: 3px;
  background: var(--line);
}

.sheet-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 16px 10px;
}
.sheet-title {
  font-size: var(--ui-font-size);
  font-weight: 600;
  color: var(--ink);
}

.sheet-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding-bottom: max(10px, env(safe-area-inset-bottom));
}

/* Slide-up + fade transition for the whole sheet (scrim fades, panel slides). */
.sheet-enter-active,
.sheet-leave-active {
  transition: opacity 0.26s ease;
}
.sheet-enter-active .sheet-panel,
.sheet-leave-active .sheet-panel {
  transition: transform 0.3s cubic-bezier(0.32, 0.72, 0, 1);
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
