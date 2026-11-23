<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import AuthMedia from './AuthMedia.vue';
import { Icon, Menu, MenuItem, Tooltip, openDialogCount } from '@moonshot-ai/app-ui';
import { openImagePreview, type ImagePreviewHandle } from '@moonshot-ai/app-client/lib';
import { getKimiWebApi } from '@moonshot-ai/app-client/client';
import { OpenWithDefaultAppKey, RevealInFolderKey } from '@moonshot-ai/app-client/contracts';
import { useWarningsStore, workspacesStore } from '@moonshot-ai/app-client/stores';
import { copyTextToClipboard } from '@moonshot-ai/app-core/lib';
import type { ToolMedia } from '@moonshot-ai/app-core/client/types';

const props = defineProps<{
  media: ToolMedia;
  originImg?: HTMLImageElement | null;
  images?: ToolMedia[];
  index?: number;
}>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const warningsStore = useWarningsStore();
const revealInFolder = inject(RevealInFolderKey, undefined);
const openWithDefaultApp = inject(OpenWithDefaultAppKey, undefined);
const localWorkspace = computed(() => workspacesStore().isLocalWorkspace);

const isImage = computed(() => props.media.kind === 'image');

const candidates: ToolMedia[] = (() => {
  if (!isImage.value) return [props.media];
  const images = (props.images ?? []).filter((item) => item.kind === 'image');
  return images.length > 0 ? images : [props.media];
})();
const matchedIndex = (() => {
  if (props.index !== undefined && props.index >= 0 && props.index < candidates.length) {
    return props.index;
  }
  const byRef = candidates.indexOf(props.media);
  if (byRef !== -1) return byRef;
  const m = props.media;
  if (m.fileId) {
    const byFile = candidates.findIndex((item) => item.fileId === m.fileId && item.sessionId === m.sessionId);
    if (byFile !== -1) return byFile;
  }
  if (m.url) {
    const byUrl = candidates.findIndex((item) => item.url === m.url);
    if (byUrl !== -1) return byUrl;
  }
  return -1;
})();
const gallery: ToolMedia[] = matchedIndex === -1 ? [props.media] : candidates;
const initialIndex = Math.max(0, matchedIndex);
const currentIndex = ref(initialIndex);
const currentMedia = computed(() => gallery[currentIndex.value] ?? props.media);

const caption = computed(() => props.media.path ?? props.media.name ?? null);

const dialogLabel = computed(
  () =>
    caption.value ??
    (props.media.kind === 'video' ? t('composer.attachmentVideo') : t('composer.attachmentImage')),
);

const overlayRef = ref<HTMLElement | null>(null);
const closeRef = ref<HTMLButtonElement | null>(null);
const imageOpened = ref(false);
let previouslyFocused: HTMLElement | null = null;
let previewHandle: ImagePreviewHandle | null = null;

const menuPos = ref<{ x: number; y: number } | null>(null);
const menuBoxRef = ref<HTMLElement | null>(null);
let focusBeforeMenu: HTMLElement | null = null;
const menuStyle = computed(() => {
  if (!menuPos.value) return {};
  const x = Math.min(menuPos.value.x, window.innerWidth - 200);
  const y = Math.min(menuPos.value.y, window.innerHeight - 180);
  return { left: `${Math.max(8, x)}px`, top: `${Math.max(8, y)}px` };
});

const canReveal = computed(() => typeof revealInFolder === 'function' && localWorkspace.value && !!currentMedia.value.path);
const canOpenDefault = computed(() => typeof openWithDefaultApp === 'function' && localWorkspace.value && !!currentMedia.value.path);
const hasPath = computed(() => !!currentMedia.value.path);

function openMenu(pos: { x: number; y: number }): void {
  focusBeforeMenu = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  menuPos.value = pos;
  void nextTick(() => {
    menuBoxRef.value?.querySelector<HTMLElement>('.ui-menu-item')?.focus();
  });
}
function closeMenu(): void {
  if (menuPos.value !== null) {
    menuPos.value = null;
    if (focusBeforeMenu?.isConnected) focusBeforeMenu.focus();
    focusBeforeMenu = null;
  }
}
function onWindowPointerDown(e: PointerEvent): void {
  const target = e.target as HTMLElement | null;
  if (!target?.closest('.media-preview-menu')) closeMenu();
}
function onWindowKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  e.stopImmediatePropagation();
  closeMenu();
}
function onMenuKeydown(e: KeyboardEvent): void {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Tab') return;
  e.preventDefault();
  const items = Array.from(menuBoxRef.value?.querySelectorAll<HTMLElement>('.ui-menu-item') ?? []);
  if (items.length === 0) return;
  const index = items.indexOf(document.activeElement as HTMLElement);
  const forward = e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey);
  const next = forward ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
  items[next]?.focus();
}

async function currentBlob(): Promise<Blob> {
  const media = currentMedia.value;
  const src = previewHandle?.currentSrc();
  if (src) {
    const res = await fetch(src).catch(() => null);
    if (res?.ok) return res.blob();
  }
  if (media.fileId) {
    const api = getKimiWebApi();
    return media.sessionId ? api.getSessionMediaBlob(media.sessionId, media.fileId) : api.getFileBlob(media.fileId);
  }
  const res = await fetch(media.url);
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  return res.blob();
}

const IMAGE_EXT: Record<string, string> = { jpeg: 'jpg', 'svg+xml': 'svg', 'vnd.microsoft.icon': 'ico', 'x-icon': 'ico' };

function imageSubtype(mime?: string): string | null {
  return /^image\/([a-z0-9.+-]+)$/i.exec(mime ?? '')?.[1]?.toLowerCase() ?? null;
}

function fileNameFor(media: ToolMedia, index: number, blobType?: string): string {
  const rawBase = media.path?.split(/[\\/]+/).pop() ?? media.name;
  const subtype = imageSubtype(blobType) ?? imageSubtype(media.mimeType);
  const base = rawBase?.replace(/\.[a-z0-9]+$/i, '');
  if (base) return subtype ? `${base}.${IMAGE_EXT[subtype] ?? subtype}` : rawBase!;
  return `image-${index + 1}.${subtype ? (IMAGE_EXT[subtype] ?? subtype) : 'png'}`;
}

async function copyImage(): Promise<void> {
  closeMenu();
  try {
    const blob = await currentBlob();
    try {
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
    } catch {
      const bitmap = await createImageBitmap(blob);
      try {
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
        const png = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
        );
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      } finally {
        bitmap.close();
      }
    }
  } catch {
    warningsStore.pushWarning({ severity: 'error', title: t('mediaPreview.copyFailed') });
  }
}

async function copyPath(): Promise<void> {
  closeMenu();
  const path = currentMedia.value.path;
  if (!path) return;
  const ok = await copyTextToClipboard(path);
  if (!ok) warningsStore.pushWarning({ severity: 'error', title: t('mediaPreview.copyFailed') });
}

async function saveAs(): Promise<void> {
  closeMenu();
  const media = currentMedia.value;
  const index = currentIndex.value;
  try {
    const blob = await currentBlob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileNameFor(media, index, blob.type);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch {
    warningsStore.pushWarning({ severity: 'error', title: t('mediaPreview.saveFailed') });
  }
}

async function reveal(): Promise<void> {
  closeMenu();
  const path = currentMedia.value.path;
  if (!path || typeof revealInFolder !== 'function') return;
  try {
    const ok = await revealInFolder(path);
    if (!ok) warningsStore.pushWarning({ severity: 'error', title: t('mediaPreview.revealFailed') });
  } catch {
    warningsStore.pushWarning({ severity: 'error', title: t('mediaPreview.revealFailed') });
  }
}

async function openDefault(): Promise<void> {
  closeMenu();
  const path = currentMedia.value.path;
  if (!path || typeof openWithDefaultApp !== 'function') return;
  try {
    const ok = await openWithDefaultApp(path);
    if (!ok) warningsStore.pushWarning({ severity: 'error', title: t('mediaPreview.openFailed') });
  } catch {
    warningsStore.pushWarning({ severity: 'error', title: t('mediaPreview.openFailed') });
  }
}

const FOCUSABLE = 'button:not([disabled]), video[controls], [tabindex]:not([tabindex="-1"])';

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    emit('close');
    return;
  }
  if (e.key !== 'Tab' || !overlayRef.value) return;
  const list = overlayRef.value.querySelectorAll<HTMLElement>(FOCUSABLE);
  const first = list[0];
  const last = list[list.length - 1];
  if (!first || !last) return;
  if (!overlayRef.value.contains(document.activeElement)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  } else if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

watch(menuPos, (pos) => {
  if (pos) {
    window.addEventListener('pointerdown', onWindowPointerDown, true);
    window.addEventListener('keydown', onWindowKeydown, true);
    window.addEventListener('resize', closeMenu);
    window.addEventListener('blur', closeMenu);
  } else {
    window.removeEventListener('pointerdown', onWindowPointerDown, true);
    window.removeEventListener('keydown', onWindowKeydown, true);
    window.removeEventListener('resize', closeMenu);
    window.removeEventListener('blur', closeMenu);
  }
});

function detachMenuListeners(): void {
  window.removeEventListener('pointerdown', onWindowPointerDown, true);
  window.removeEventListener('keydown', onWindowKeydown, true);
  window.removeEventListener('resize', closeMenu);
  window.removeEventListener('blur', closeMenu);
}

onMounted(() => {
  if (isImage.value) {
    previewHandle = openImagePreview({
      api: getKimiWebApi(),
      images: gallery,
      index: initialIndex,
      thumbImg: props.originImg ?? null,
      labels: { prev: t('mediaPreview.prevImage'), next: t('mediaPreview.nextImage') },
      onOpen: () => {
        imageOpened.value = true;
      },
      onClose: () => emit('close'),
      onSlideChange: (index) => {
        currentIndex.value = index;
        closeMenu();
      },
      onImageContextMenu: openMenu,
    });
    return;
  }
  openDialogCount.value += 1;
  previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  window.addEventListener('keydown', onKeydown);
  closeRef.value?.focus();
});

onBeforeUnmount(() => {
  detachMenuListeners();
  if (previewHandle) {
    previewHandle.close();
    previewHandle = null;
    return;
  }
  openDialogCount.value = Math.max(0, openDialogCount.value - 1);
  window.removeEventListener('keydown', onKeydown);
  previouslyFocused?.focus();
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="!isImage"
      ref="overlayRef"
      class="media-lightbox"
      role="dialog"
      aria-modal="true"
      :aria-label="dialogLabel"
      @mousedown.self="emit('close')"
    >
      <Tooltip :text="t('model.close')">
        <button
          ref="closeRef"
          type="button"
          class="media-lightbox-close"
          :aria-label="t('model.close')"
          @click="emit('close')"
        >
          <Icon name="close" size="sm" />
        </button>
      </Tooltip>
      <div class="media-lightbox-card">
        <div class="media-lightbox-frame">
          <AuthMedia
            :url="media.url"
            :kind="media.kind === 'video' ? 'video' : 'image'"
            :file-id="media.fileId"
            :session-id="media.sessionId"
            media-class="media-lightbox-media"
            :controls="media.kind === 'video'"
          />
        </div>
        <div v-if="caption" class="media-lightbox-name">{{ caption }}</div>
      </div>
    </div>
    <Tooltip v-else-if="imageOpened" :text="t('model.close')">
      <button
        type="button"
        class="media-lightbox-close"
        :aria-label="t('model.close')"
        @click="emit('close')"
      >
        <Icon name="close" size="sm" />
      </button>
    </Tooltip>
    <div
      v-if="isImage && menuPos"
      ref="menuBoxRef"
      class="ui-menu-floating media-preview-menu"
      :style="menuStyle"
      @keydown="onMenuKeydown"
    >
      <Menu>
        <MenuItem @click="copyImage"><Icon name="copy" size="md" class="mpm-icon" />{{ t('mediaPreview.copyImage') }}</MenuItem>
        <MenuItem v-if="hasPath" @click="copyPath"><Icon name="link" size="md" class="mpm-icon" />{{ t('mediaPreview.copyPath') }}</MenuItem>
        <MenuItem @click="saveAs"><Icon name="download" size="md" class="mpm-icon" />{{ t('mediaPreview.saveAs') }}</MenuItem>
        <MenuItem v-if="canReveal" @click="reveal"><Icon name="folder" size="md" class="mpm-icon" />{{ t('mediaPreview.reveal') }}</MenuItem>
        <MenuItem v-if="canOpenDefault" @click="openDefault"><Icon name="external-link" size="md" class="mpm-icon" />{{ t('mediaPreview.openDefault') }}</MenuItem>
      </Menu>
    </div>
  </Teleport>
</template>

<style scoped>
.media-lightbox {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-6);
  padding-top: calc(var(--space-6) + var(--media-preview-top-inset, 0px));
  background: var(--color-scrim-strong);
  -webkit-app-region: no-drag;
}
.media-lightbox-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  max-width: min(960px, calc(100vw - var(--space-6) * 2));
  max-height: calc(var(--app-height, 100vh) - var(--space-6) * 2 - var(--media-preview-top-inset, 0px));
}
.media-lightbox-frame {
  max-width: 100%;
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--color-bg);
  box-shadow: var(--shadow-xl);
}
.media-lightbox-media {
  display: block;
  max-width: 100%;
  max-height: calc(var(--app-height, 100vh) - var(--space-6) * 4 - var(--media-preview-top-inset, 0px));
  object-fit: contain;
}
.media-lightbox-name {
  max-width: 100%;
  color: var(--color-text-on-scrim);
  font-size: var(--text-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.media-lightbox-close {
  position: fixed;
  top: calc(var(--space-4) + var(--media-preview-top-inset, 0px));
  right: var(--space-6);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-full);
  background: var(--color-surface-raised);
  color: var(--color-text);
  box-shadow: var(--shadow-sm);
  cursor: pointer;
  z-index: var(--z-modal-dropdown);
  -webkit-app-region: no-drag;
}
.media-lightbox-close::before {
  content: '';
  position: absolute;
  inset: -6px;
}
.media-lightbox-close:hover {
  border-color: var(--color-line-strong);
  background: var(--color-surface-sunken);
}
.media-preview-menu {
  z-index: var(--z-modal-dropdown);
  -webkit-app-region: no-drag;
}
.mpm-icon {
  flex: none;
  color: var(--color-text-muted);
}
.media-lightbox-close:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
</style>
