<!-- apps/kimi-web/src/components/chat/AuthMedia.vue
     Renders a user-uploaded image/video whose bytes live in the daemon file
     store. The bare getFileUrl(fileId) 401s when used as a <video>/<img> src
     because the browser loads those natively and never attaches our Bearer
     credential — so when a fileId is present we fetch the bytes through the
     authenticated API client and play from a page-local blob URL instead. -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { getKimiWebApi } from '../../api';

const props = withDefaults(
  defineProps<{
    url: string;
    kind: 'image' | 'video';
    alt?: string;
    /** File-store id. When present the bytes are fetched with auth and played
     *  from a blob URL; otherwise `url` is used directly (e.g. a data: URL). */
    fileId?: string;
    mediaClass?: string;
    /** Video: show native controls. Defaults to true (chat bubble); queue
     *  thumbnails pass false. */
    controls?: boolean;
    /** Video: start muted. */
    muted?: boolean;
  }>(),
  { mediaClass: 'u-img', controls: true, muted: false },
);

const resolvedUrl = ref<string>(props.fileId ? '' : props.url);
const mediaEl = ref<HTMLElement | null>(null);
// Flips true once the element nears the viewport, deferring the authenticated
// download so a session with many historical large uploads doesn't fetch every
// blob (and hold them in memory) before the user ever scrolls to or plays them.
const visible = ref(!props.fileId);
let objectUrl: string | null = null;
// Sequence guard + unmount flag: a reused component (e.g. queued thumbnails
// keyed by index) can change fileId before a previous fetch resolves, and an
// in-flight fetch can outlive the component. In both cases the stale response
// must not win or leak its blob URL.
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
  if (!visible.value) return; // defer until near the viewport
  try {
    const blob = await getKimiWebApi().getFileBlob(props.fileId);
    const url = URL.createObjectURL(blob);
    if (disposed || seq !== requestSeq) {
      URL.revokeObjectURL(url);
      return;
    }
    objectUrl = url;
    resolvedUrl.value = objectUrl;
  } catch {
    if (disposed || seq !== requestSeq) return;
    // Honest broken-media state beats a blank box if the authenticated fetch fails.
    resolvedUrl.value = props.url;
  }
}

watch(() => [props.fileId, props.url, visible.value] as const, resolve, { immediate: true });

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
    :class="mediaClass"
    :src="resolvedUrl || undefined"
    :alt="alt || ''"
    loading="lazy"
  />
</template>
