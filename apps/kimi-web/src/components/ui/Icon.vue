<!-- apps/kimi-web/src/components/ui/Icon.vue -->
<!-- Design-system §02 icon primitive. Renders a registered line icon from
     lib/icons.ts at a token size. Use everywhere instead of hand-writing raw SVG. -->
<script setup lang="ts">
import { computed } from 'vue';
import { getIcon, SIZE_PX, type IconName, type IconSize } from '../../lib/icons';

const props = withDefaults(
  defineProps<{
    name: IconName;
    size?: IconSize;
    /** Accessible label. When omitted the icon is decorative (aria-hidden). */
    label?: string;
  }>(),
  { size: 'md' },
);

const entry = computed(() => getIcon(props.name));
const px = computed(() => SIZE_PX[props.size]);
</script>

<template>
  <component
    v-if="entry"
    :is="entry.component"
    class="kw-icon"
    :width="px"
    :height="px"
    :aria-label="label"
    :aria-hidden="label ? undefined : true"
  />
</template>
