<script setup lang="ts">
import { computed, inject } from 'vue';
import { IconResolverKey, SIZE_PX, type IconSize } from '../../icons';

const props = withDefaults(
  defineProps<{
    name: string;
    size?: IconSize;
    label?: string;
  }>(),
  { size: 'md' },
);

const resolve = inject(IconResolverKey, () => undefined);
const entryComp = computed(() => resolve(props.name));
const px = computed(() => SIZE_PX[props.size]);
</script>

<template>
  <component
    v-if="entryComp"
    :is="entryComp"
    class="kw-icon"
    :width="px"
    :height="px"
    :aria-label="label"
    :aria-hidden="label ? undefined : true"
  />
</template>
