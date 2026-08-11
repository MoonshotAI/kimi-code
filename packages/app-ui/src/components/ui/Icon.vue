<!-- apps/kimi-web/src/components/ui/Icon.vue -->
<!-- Design-system §02 icon primitive. Resolves a named line icon through the
     consumer-provided IconResolverKey registry at a token size. Use everywhere
     instead of hand-writing raw SVG. -->
<script setup lang="ts">
import { computed, inject } from 'vue';
import { IconResolverKey, SIZE_PX, type IconSize } from '../../icons';

const props = withDefaults(
  defineProps<{
    name: string;
    size?: IconSize;
    /** Accessible label. When omitted the icon is decorative (aria-hidden). */
    label?: string;
  }>(),
  { size: 'md' },
);

// Resolve the icon component through the consumer-provided registry (bridged at
// app setup via `app.provide(IconResolverKey, ...)`). Falls back to undefined so
// an unregistered / unprovided name renders nothing rather than throwing.
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
