<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from 'vue';
import { ScrollArea } from '@moonshot-ai/app-ui';
const area = ref<InstanceType<typeof ScrollArea>>();
const above = ref(false);
const below = ref(false);
let observer: ResizeObserver | undefined;
let mutations: MutationObserver | undefined;
function update(): void {
  const el = area.value?.viewport;
  if (!el) return;
  above.value = el.scrollTop > 1;
  below.value = el.scrollHeight - el.clientHeight - el.scrollTop > 1;
}
onMounted(async () => {
  await nextTick();
  const el = area.value?.viewport;
  if (!el) return;
  el.addEventListener('scroll', update, { passive: true });
  observer = new ResizeObserver(update);
  observer.observe(el);
  for (const child of el.children) observer.observe(child);
  mutations = new MutationObserver(update);
  mutations.observe(el, { childList: true, subtree: true, characterData: true });
  update();
});
onUnmounted(() => { area.value?.viewport?.removeEventListener('scroll', update); observer?.disconnect(); mutations?.disconnect(); });
</script>
<template><ScrollArea ref="area" class="annotation-scroll" :class="{ above, below }"><slot /></ScrollArea></template>
<style scoped>
.annotation-scroll { display: flex; flex-direction: column; min-height: 0; --fade-top: 0rem; --fade-bottom: 0rem; }
.annotation-scroll.above { --fade-top: 1rem; }
.annotation-scroll.below { --fade-bottom: 1rem; }
.annotation-scroll :deep(.ui-scroll-area__viewport) { flex: 1; min-height: 0; height: auto; mask-image: linear-gradient(to bottom, transparent, black var(--fade-top), black calc(100% - var(--fade-bottom)), transparent); }
</style>
