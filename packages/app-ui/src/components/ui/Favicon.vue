<script setup lang="ts">
import { ref, watch } from 'vue';
import { knownFaviconInk, readFaviconInk, type FaviconInk } from '@moonshot-ai/app-core/lib';

const props = defineProps<{ src: string }>();
const ink = ref<FaviconInk | null>(knownFaviconInk(props.src) ?? null);

watch(() => props.src, (src) => {
  ink.value = knownFaviconInk(src) ?? null;
});

function onLoad(event: Event): void {
  if (event.currentTarget instanceof HTMLImageElement) ink.value = readFaviconInk(props.src, event.currentTarget);
}
</script>

<template>
  <img class="ui-favicon" :src="src" :data-ink="ink ?? undefined" alt="" @load="onLoad" />
</template>

<style scoped>
.ui-favicon[data-ink='dark'] { filter: var(--favicon-dark-ink-filter); }
.ui-favicon[data-ink='light'] { filter: var(--favicon-light-ink-filter); }
</style>
