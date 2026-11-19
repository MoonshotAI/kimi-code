<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { getKimiWebApi } from '@moonshot-ai/app-client/client';

const props = withDefaults(
  defineProps<{
    url: string;
    kind: 'image' | 'video';
    alt?: string;
    fileId?: string;
    sessionId?: string;
    mediaClass?: string;
    controls?: boolean;
    muted?: boolean;
  }>(),
  { mediaClass: 'u-img', controls: true, muted: false },
);

const resolvedUrl = ref<string>(props.fileId ? '' : props.url);
const mediaEl = ref<HTMLElement | null>(null);
const visible = ref(!props.fileId);
let objectUrl: string | null = null;
let requestSeq = 0;
let disposed = false;
let observer: IntersectionObserver | null = null;

function revoke(): void {
  if (objectUrl !== null) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
}

async function resolve(): Promise<void> {
  const seq = ++requestSeq;
  revoke();
  if (!props.fileId) {
    resolvedUrl.value = props.url;
    return;
  }
  resolvedUrl.value = '';
  if (!visible.value) return;
  try {
    const blob = props.sessionId
      ? await getKimiWebApi().getSessionMediaBlob(props.sessionId, props.fileId)
      : await getKimiWebApi().getFileBlob(props.fileId);
    const url = URL.createObjectURL(blob);
    if (disposed || seq !== requestSeq) {
      URL.revokeObjectURL(url);
      return;
    }
    objectUrl = url;
    resolvedUrl.value = objectUrl;
  } catch {
    if (disposed || seq !== requestSeq) return;
    resolvedUrl.value = '';
  }
}

watch(() => [props.fileId, props.sessionId, props.url, visible.value] as const, resolve, { immediate: true });

onMounted(() => {
  if (typeof IntersectionObserver === 'function' && mediaEl.value) {
    observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          visible.value = true;
          observer?.disconnect();
          observer = null;
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(mediaEl.value);
  } else {
    visible.value = true;
  }
});

onBeforeUnmount(() => {
  disposed = true;
  observer?.disconnect();
  observer = null;
  revoke();
});
</script>

<template>
  <video
    v-if="kind === 'video'"
    ref="mediaEl"
    :class="mediaClass"
    :src="resolvedUrl || undefined"
    :controls="controls"
    :muted="muted"
    playsinline
    preload="metadata"
  />
  <img
    v-else
    ref="mediaEl"
    :class="[mediaClass, { 'is-resolving': !resolvedUrl }]"
    :src="resolvedUrl || undefined"
    :alt="alt || ''"
    loading="lazy"
  />
</template>

<style scoped>
.is-resolving {
  visibility: hidden;
}
</style>
