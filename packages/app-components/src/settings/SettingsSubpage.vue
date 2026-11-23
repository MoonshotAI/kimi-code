<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { isImeKeyEvent } from '@moonshot-ai/app-client/lib';
import { Icon } from '@moonshot-ai/app-ui';
import { SettingsSubpageHostKey } from './useSettingsSubpage';

const props = defineProps<{ parentTitle: string; title: string; description?: string; fit?: boolean }>();
const emit = defineEmits<{ back: [] }>();

const { t } = useI18n();
const backRef = ref<HTMLButtonElement>();
const host = inject(SettingsSubpageHostKey, null);
const backTarget = computed(() => host?.header() ?? null);

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.defaultPrevented || isImeKeyEvent(event)) return;
  event.preventDefault();
  emit('back');
}

onMounted(() => {
  if (props.fit) host?.fit();
  backRef.value?.focus({ preventScroll: true });
});
onBeforeUnmount(() => host?.release());
</script>

<template>
  <section class="settings-subpage" :aria-label="title" @keydown="onKeydown">
    <Teleport :to="backTarget ?? 'body'" :disabled="backTarget === null">
      <button
        ref="backRef"
        type="button"
        class="settings-subpage-back"
        :class="{ 'settings-subpage-back--header': backTarget !== null }"
        :aria-label="t('settings.backTo', { page: parentTitle })"
        @click="emit('back')"
        @keydown="onKeydown"
      >
        <Icon name="chevron-left" size="sm" />
        <span>{{ parentTitle }}</span>
      </button>
    </Teleport>
    <header class="settings-subpage-head">
      <h3 class="settings-subpage-title">{{ title }}</h3>
      <p v-if="description" class="settings-subpage-desc">{{ description }}</p>
    </header>
    <slot />
  </section>
</template>

<style scoped>
.settings-subpage {
  display: flex;
  flex: none;
  flex-direction: column;
  min-width: 0;
  padding-bottom: var(--space-8);
}
.settings-subpage-back {
  display: inline-flex;
  align-self: flex-start;
  align-items: center;
  gap: var(--space-1);
  height: var(--icon-button-sm);
  margin-left: calc(-1 * var(--space-2));
  padding: 0 var(--space-2) 0 var(--space-1);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
}
.settings-subpage-back--header {
  align-self: center;
  order: -1;
  margin-right: auto;
  margin-left: var(--space-5);
}
.settings-subpage-back:hover {
  background: var(--color-hover);
  color: var(--color-text-strong);
}
.settings-subpage-back:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.settings-subpage-head {
  margin: var(--space-3) 0 var(--space-4);
}
.settings-subpage-title {
  margin: 0;
  font-family: var(--font-ui);
  font-size: var(--text-lg);
  font-weight: var(--weight-medium);
  color: var(--color-text);
}
.settings-subpage-desc {
  margin: var(--space-1) 0 0;
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--color-text-muted);
}
</style>
