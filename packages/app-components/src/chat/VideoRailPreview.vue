<script setup lang="ts">
import { ref } from 'vue';
import { useVideoRailPreview } from './useVideoRailPreview';

const props = defineProps<{
  fileId: string;
  sessionId?: string;
}>();
const host = ref<HTMLElement | null>(null);
const thumbnail = useVideoRailPreview(host, props);
</script>

<template>
  <span ref="host" aria-hidden="true">
    <img v-if="thumbnail" :src="thumbnail" alt="" draggable="false" />
  </span>
</template>

<style scoped>
img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
</style>
