<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { SegmentedControl } from '@moonshot-ai/app-ui';
import type { RunningSendMode } from '@moonshot-ai/app-client/composables';

const props = withDefaults(defineProps<{
  modelValue: RunningSendMode;
  highlighted?: boolean;
  mobile?: boolean;
}>(), {
  highlighted: false,
  mobile: false,
});

const emit = defineEmits<{
  'update:modelValue': [mode: RunningSendMode];
}>();

const { t } = useI18n();
const root = ref<HTMLElement | null>(null);
const options = computed(() => [
  { value: 'steer', label: t('settings.runningSendSteer') },
  { value: 'queue', label: t('settings.runningSendQueue') },
]);

function scrollIntoView(options?: ScrollIntoViewOptions): void {
  root.value?.scrollIntoView(options);
}

defineExpose({ scrollIntoView });
</script>

<template>
  <div
    ref="root"
    :class="[
      props.mobile ? 'srow read-only pref' : 'row',
      {
        'srow-highlighted': props.mobile && props.highlighted,
        'row-highlighted': !props.mobile && props.highlighted,
      },
    ]"
    :data-setting-highlighted="props.highlighted ? 'true' : undefined"
  >
    <span :class="props.mobile ? 'srow-main' : 'rlabel'">
      <span :class="props.mobile ? 'srow-label' : undefined">{{ t('settings.runningSendMode') }}</span>
      <span :class="props.mobile ? 'srow-sub' : 'hint'">{{ t('settings.runningSendModeHint') }}</span>
    </span>
    <SegmentedControl
      :model-value="modelValue"
      :options="options"
      :aria-label="t('settings.runningSendMode')"
      @update:model-value="emit('update:modelValue', $event as RunningSendMode)"
    />
  </div>
</template>
