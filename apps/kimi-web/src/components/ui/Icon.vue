<!-- apps/kimi-web/src/components/ui/Icon.vue -->
<!-- Design-system §02 icon primitive. Renders a registered line icon from
     lib/icons.ts at a token size. Use everywhere instead of hand-writing <svg>. -->
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

const def = computed(() => getIcon(props.name));
const px = computed(() => SIZE_PX[props.size]);
const viewBox = computed(() => def.value.viewBox ?? '0 0 16 16');
</script>

<template>
  <svg
    v-if="def.fill"
    class="kw-icon"
    :width="px"
    :height="px"
    :viewBox="viewBox"
    fill="currentColor"
    :aria-label="label"
    :aria-hidden="label ? undefined : true"
    xmlns="http://www.w3.org/2000/svg"
    v-html="def.body"
  />
  <svg
    v-else
    class="kw-icon"
    :width="px"
    :height="px"
    :viewBox="viewBox"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    :aria-label="label"
    :aria-hidden="label ? undefined : true"
    xmlns="http://www.w3.org/2000/svg"
    v-html="def.body"
  />
</template>
