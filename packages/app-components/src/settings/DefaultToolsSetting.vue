<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import DefaultToolsPanel from './DefaultToolsPanel.vue';
import DefaultToolsRow from './DefaultToolsRow.vue';
import { useSettingsSubpage } from './useSettingsSubpage';

const emit = defineEmits<{ openChange: [open: boolean] }>();
const { t } = useI18n();
const page = useSettingsSubpage<'tools'>();
const open = computed(() => page.page.value !== null);
const panelRef = ref<InstanceType<typeof DefaultToolsPanel> | null>(null);

watch(open, (value) => emit('openChange', value), { immediate: true });

async function confirmDiscard(): Promise<boolean> {
  if (!open.value || panelRef.value === null) return true;
  return await panelRef.value.confirmDiscard();
}

function reset(): void {
  page.reset();
}

onUnmounted(() => {
  emit('openChange', false);
});

defineExpose({ confirmDiscard, reset });
</script>

<template>
  <section v-if="!open" class="sec">
    <h3 class="sec-title">{{ t('settings.defaultTools') }}</h3>
    <DefaultToolsRow @open="page.open('tools', $event)" />
  </section>
  <DefaultToolsPanel v-else ref="panelRef" @back="page.back()" />
</template>

<style scoped src="./settings-common.css"></style>
