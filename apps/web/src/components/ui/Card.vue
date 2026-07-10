<!-- apps/kimi-web/src/components/ui/Card.vue -->
<!-- Design-system §03 Card: a single flat surface with head / body / foot slots. -->
<script setup lang="ts">
withDefaults(defineProps<{
  elevated?: boolean;
}>(), {
  elevated: false,
});
</script>

<template>
  <div class="ui-card" :class="{ 'is-elevated': elevated }">
    <div v-if="$slots.head" class="ui-card__head"><slot name="head" /></div>
    <div class="ui-card__body"><slot /></div>
    <div v-if="$slots.foot" class="ui-card__foot"><slot name="foot" /></div>
  </div>
</template>

<style scoped>
.ui-card {
  background: var(--color-surface);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.ui-card.is-elevated { box-shadow: var(--shadow-md); border-color: transparent; }

.ui-card__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 10px 14px;
  border-bottom: 1px solid var(--color-line);
  background: var(--color-surface);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--color-text);
}
.ui-card__body { padding: 14px; color: var(--color-text-muted); }
.ui-card__foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  padding: 10px 14px;
  border-top: 1px solid var(--color-line);
  background: var(--color-surface);
}
</style>
