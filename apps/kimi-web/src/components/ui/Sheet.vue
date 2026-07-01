<!-- apps/kimi-web/src/components/ui/Sheet.vue -->
<!-- Design-system §03 Sheet / BottomSheet: mobile bottom panel (≤640px dialogs
     anchor here). Top radius xl + drag handle + xl shadow. -->
<script setup lang="ts">
import IconButton from './IconButton.vue';
import Icon from './Icon.vue';

defineProps<{ open: boolean; title?: string }>();

const emit = defineEmits<{ 'update:open': [value: boolean]; close: [] }>();

function close() {
  emit('update:open', false);
  emit('close');
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="ui-sheet__scrim" @mousedown.self="close">
      <div class="ui-sheet" role="dialog" aria-modal="true">
        <div class="ui-sheet__handle" aria-hidden="true" />
        <div v-if="title" class="ui-sheet__head">
          <span class="ui-sheet__title">{{ title }}</span>
          <IconButton size="sm" label="Close" @click="close">
            <Icon name="close" size="md" />
          </IconButton>
        </div>
        <div class="ui-sheet__body"><slot /></div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ui-sheet__scrim {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  background: rgba(13, 17, 23, 0.45);
}
.ui-sheet {
  width: 100%;
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  background: var(--color-surface-raised);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-xl) var(--radius-xl) 0 0;
  box-shadow: var(--shadow-xl);
  overflow: hidden;
}
.ui-sheet__handle {
  width: 36px;
  height: 4px;
  margin: var(--space-2) auto 0;
  border-radius: var(--radius-full);
  background: var(--color-line-strong);
  flex: none;
}
.ui-sheet__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
}
.ui-sheet__title { flex: 1; font-size: var(--text-lg); font-weight: var(--weight-medium); color: var(--color-text); }
.ui-sheet__body { padding: var(--space-2) var(--space-4) var(--space-5); overflow: auto; color: var(--color-text); }
</style>
