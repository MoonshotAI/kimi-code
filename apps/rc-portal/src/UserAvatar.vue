<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Avatar, Icon } from '@moonshot-ai/app-ui';

const props = withDefaults(defineProps<{
  src?: string;
  size?: 'sm' | 'md';
}>(), {
  src: '',
  size: 'md',
});

const loadFailed = ref(false);
watch(() => props.src, () => {
  loadFailed.value = false;
});
const showImage = computed(() => Boolean(props.src) && !loadFailed.value);
</script>

<template>
  <Avatar :size="size" class="user-avatar">
    <img v-if="showImage" :src="src" alt="" @error="loadFailed = true" />
    <Icon v-else name="user" :size="size" />
  </Avatar>
</template>

<style scoped>
.user-avatar { border-radius: 50%; }
.user-avatar img { width: 100%; height: 100%; object-fit: cover; }
</style>
