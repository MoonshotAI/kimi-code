<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon, IconButton, Input } from '@moonshot-ai/app-ui';
import {
  asBrowserDeviceModeRequest,
  BROWSER_DEVICE_DIMENSION_MAX,
  BROWSER_DEVICE_DIMENSION_MIN,
  BROWSER_DEVICE_PROFILES,
  BROWSER_DEVICE_SCALE_OPTIONS,
  type BrowserDeviceModeRequest,
  type BrowserDeviceProfileId,
  type BrowserDeviceState,
} from '../../../shared/browser-device';
import { browserDeviceMenuItems, profileLabelKeys } from '../../lib/browserDeviceMenu';
import { registerBrowserOverlayMenu } from '../../lib/browserOverlayMenu';

const props = defineProps<{
  browserId: string;
  device: BrowserDeviceState;
  background: string;
  updateDeviceMode: (request: BrowserDeviceModeRequest) => Promise<void>;
}>();
const emit = defineEmits<{
  backgroundChange: [value: string];
}>();

const { t } = useI18n();
const deviceButton = ref<HTMLButtonElement | null>(null);
const backgroundButton = ref<HTMLButtonElement | null>(null);
const backgroundMenu = registerBrowserOverlayMenu({
  id: `browser.device.background.${props.browserId}`, width: 180, placement: 'bottom-start',
  items: () => [['auto', 'backgroundAuto'], ['#ffffff', 'backgroundLight'], ['#1f1f1f', 'backgroundDark']].map(([value, key]) => ({ kind: 'item' as const, id: value === 'auto' ? 'auto' : value!.slice(1), label: t(`browser.device.${key}`), selected: props.background === value })),
  onSelect: id => emit('backgroundChange', id === 'auto' ? 'auto' : `#${id}`),
});
const scaleButton = ref<HTMLButtonElement | null>(null);
const dimensionsGroup = ref<HTMLDivElement | null>(null);
const widthDraft = ref(String(props.device.width));
const heightDraft = ref(String(props.device.height));
const lastResponsiveWidth = ref(
  props.device.profileId === 'responsive' ? props.device.width : 393,
);
const lastResponsiveHeight = ref(
  props.device.profileId === 'responsive' ? props.device.height : 852,
);
const lastResponsiveOrientation = ref(props.device.orientation);

const profileLabel = computed(() => t(profileLabelKeys[props.device.profileId]));
const scaleLabel = computed(() => `${Math.round(props.device.displayScale * 100)}%`);

let pendingUpdates = 0;
let latestRequest: Extract<BrowserDeviceModeRequest, { enabled: true }> | null = null;
let syncingDrafts = false;
let widthDirty = false;
let heightDirty = false;
let syncedProfileId = props.device.profileId;
watch(widthDraft, () => { if (!syncingDrafts) widthDirty = true; }, { flush: 'sync' });
watch(heightDraft, () => { if (!syncingDrafts) heightDirty = true; }, { flush: 'sync' });

function setDimensionDrafts(width: number, height: number): void {
  syncingDrafts = true;
  widthDraft.value = String(width);
  heightDraft.value = String(height);
  syncingDrafts = false;
}

function syncDeviceDrafts(): void {
  if (pendingUpdates > 0) return;
  const { width, height, profileId, orientation } = props.device;
  if (syncedProfileId !== profileId) {
    widthDirty = false;
    heightDirty = false;
  }
  syncedProfileId = profileId;
  syncingDrafts = true;
  if (!widthDirty) widthDraft.value = String(width);
  if (!heightDirty) heightDraft.value = String(height);
  syncingDrafts = false;
  if (profileId === 'responsive') {
    lastResponsiveWidth.value = width;
    lastResponsiveHeight.value = height;
    lastResponsiveOrientation.value = orientation;
  }
}

watch(
  () => [props.device.width, props.device.height, props.device.profileId, props.device.orientation] as const,
  syncDeviceDrafts,
);

async function submit(request: BrowserDeviceModeRequest): Promise<void> {
  pendingUpdates += 1;
  latestRequest = request.enabled ? { ...request } : null;
  if (request.enabled && request.profileId === 'responsive') {
    lastResponsiveWidth.value = request.width!;
    lastResponsiveHeight.value = request.height!;
    lastResponsiveOrientation.value = request.orientation;
  }
  try {
    await props.updateDeviceMode(request);
  } catch {
  } finally {
    await nextTick();
    pendingUpdates -= 1;
    if (pendingUpdates === 0) latestRequest = null;
    syncDeviceDrafts();
  }
}

function currentProfileId(): BrowserDeviceProfileId {
  return latestRequest?.profileId ?? props.device.profileId;
}

function currentOrientation(): BrowserDeviceState['orientation'] {
  return latestRequest?.orientation ?? props.device.orientation;
}

function currentScaleRequest(): Pick<
  Extract<BrowserDeviceModeRequest, { enabled: true }>,
  'scaleMode' | 'scale'
> {
  if (latestRequest !== null) {
    return latestRequest.scaleMode === 'fit' ? { scaleMode: 'fit' } : { scaleMode: 'fixed', scale: latestRequest.scale };
  }
  return props.device.scaleMode === 'fit'
    ? { scaleMode: 'fit' }
    : { scaleMode: 'fixed', scale: props.device.requestedScale };
}

function profileRequest(profileId: 'responsive', scaleRequest?: ReturnType<typeof currentScaleRequest>): Extract<BrowserDeviceModeRequest, { enabled: true; profileId: 'responsive' }>;
function profileRequest(profileId: BrowserDeviceProfileId, scaleRequest?: ReturnType<typeof currentScaleRequest>): Extract<BrowserDeviceModeRequest, { enabled: true }>;
function profileRequest(
  profileId: BrowserDeviceProfileId,
  scaleRequest = currentScaleRequest(),
): Extract<BrowserDeviceModeRequest, { enabled: true }> {
  const responsiveOrientationChanged =
    profileId === 'responsive' && lastResponsiveOrientation.value !== currentOrientation();
  const request = asBrowserDeviceModeRequest({
    enabled: true,
    profileId,
    orientation: currentOrientation(),
    ...(profileId === 'responsive'
      ? {
          width: responsiveOrientationChanged
            ? lastResponsiveHeight.value
            : lastResponsiveWidth.value,
          height: responsiveOrientationChanged
            ? lastResponsiveWidth.value
            : lastResponsiveHeight.value,
        }
      : {}),
    ...scaleRequest,
  });
  if (request === null || !request.enabled) throw new Error('Invalid device mode request.');
  return request;
}

const deviceMenu = registerBrowserOverlayMenu({
  id: `browser.device.profile.${props.browserId}`,
  width: 460,
  placement: 'bottom-start',
  offset: 4,
  items: () => browserDeviceMenuItems(props.device.profileId, t),
  onSelect: (itemId) => {
    if (Object.hasOwn(profileLabelKeys, itemId)) {
      const profile = BROWSER_DEVICE_PROFILES.find(entry => entry.id === itemId)!;
      void submit({ ...profileRequest(profile.id), orientation: profile.mobile ? currentOrientation() : 'landscape' });
    }
  },
});

const scaleMenu = registerBrowserOverlayMenu({
  id: `browser.device.scale.${props.browserId}`,
  width: 200,
  placement: 'bottom-start',
  offset: 4,
  items: () => [
    {
      kind: 'item' as const,
      id: 'fit',
      label: t('browser.device.fitToWindow'),
      selected: props.device.scaleMode === 'fit',
    },
    { kind: 'separator' as const },
    ...[...BROWSER_DEVICE_SCALE_OPTIONS].reverse().map((scale) => ({
      kind: 'item' as const,
      id: `scale-${scale}`,
      label: `${Math.round(scale * 100)}%`,
      selected:
        props.device.scaleMode === 'fixed' &&
        Math.abs(props.device.requestedScale - scale) < 0.001,
      disabled: scale > props.device.maxDisplayScale + 0.001,
    })),
  ],
  onSelect: (itemId) => {
    if (itemId === 'fit') {
      void submit(profileRequest(currentProfileId(), { scaleMode: 'fit' }));
      return;
    }
    const scale = Number(itemId.replace('scale-', ''));
    if (!BROWSER_DEVICE_SCALE_OPTIONS.some((option) => option === scale)) return;
    void submit(
      profileRequest(currentProfileId(), { scaleMode: 'fixed', scale }),
    );
  },
});

function toggleDeviceMenu(): void {
  if (deviceButton.value !== null) deviceMenu.toggle(deviceButton.value);
}

function toggleScaleMenu(): void {
  if (scaleButton.value !== null) scaleMenu.toggle(scaleButton.value);
}

function normalizedDimension(value: string, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(
    BROWSER_DEVICE_DIMENSION_MIN,
    Math.min(BROWSER_DEVICE_DIMENSION_MAX, Math.round(parsed)),
  );
}

function commitDimensions(): void {
  if (currentProfileId() !== 'responsive') return;
  const width = normalizedDimension(widthDraft.value, props.device.width);
  const height = normalizedDimension(heightDraft.value, props.device.height);
  const orientation = width <= height ? 'portrait' : 'landscape';
  const changed = widthDirty || heightDirty || width !== props.device.width || height !== props.device.height;
  setDimensionDrafts(width, height);
  widthDirty = false;
  heightDirty = false;
  if (!changed) return;
  lastResponsiveWidth.value = width;
  lastResponsiveHeight.value = height;
  lastResponsiveOrientation.value = orientation;
  void submit({
    ...profileRequest('responsive'),
    orientation,
    width,
    height,
  });
}

function onDimensionBlur(): void {
  queueMicrotask(() => {
    if (dimensionsGroup.value?.contains(document.activeElement)) return;
    commitDimensions();
  });
}

function rotate(): void {
  const orientation = currentOrientation() === 'portrait' ? 'landscape' : 'portrait';
  if (currentProfileId() === 'responsive') {
    const dimensions = latestRequest?.profileId === 'responsive' ? latestRequest : props.device;
    const width = normalizedDimension(heightDirty ? heightDraft.value : String(dimensions.height), props.device.height);
    const height = normalizedDimension(widthDirty ? widthDraft.value : String(dimensions.width), props.device.width);
    const responsiveOrientation = width === height
      ? lastResponsiveOrientation.value === 'portrait' ? 'landscape' : 'portrait'
      : width < height ? 'portrait' : 'landscape';
    setDimensionDrafts(width, height);
    widthDirty = false;
    heightDirty = false;
    lastResponsiveWidth.value = width;
    lastResponsiveHeight.value = height;
    lastResponsiveOrientation.value = responsiveOrientation;
    void submit({
      ...profileRequest('responsive'),
      orientation: responsiveOrientation,
      width,
      height,
    });
    return;
  }
  void submit({
    ...profileRequest(currentProfileId()),
    orientation,
  });
}
</script>

<template>
  <div class="device-toolbar" :aria-label="t('browser.device.toolbarAria')">
    <div class="device-toolbar__controls">
      <span class="device-toolbar__label">{{ t('browser.device.dimensions') }}</span>
      <button
        ref="deviceButton"
        class="device-toolbar__select device-toolbar__device"
        type="button"
        aria-haspopup="menu"
        :aria-expanded="deviceMenu.open.value"
        data-testid="browser-device-profile"
        @click="toggleDeviceMenu"
      >
        <span>{{ profileLabel }}</span>
        <Icon name="chevron-down" />
      </button>

      <div ref="dimensionsGroup" class="device-toolbar__dimensions">
        <Input
          v-model="widthDraft"
          class="device-toolbar__dimension"
          size="xs"
          type="number"
          inputmode="numeric"
          :min="BROWSER_DEVICE_DIMENSION_MIN"
          :max="BROWSER_DEVICE_DIMENSION_MAX"
          :readonly="device.profileId !== 'responsive'"
          :aria-label="t('browser.device.width')"
          data-testid="browser-device-width"
          @blur="onDimensionBlur"
          @keydown.enter.prevent="commitDimensions"
        />
        <span class="device-toolbar__times" aria-hidden="true">×</span>
        <Input
          v-model="heightDraft"
          class="device-toolbar__dimension"
          size="xs"
          type="number"
          inputmode="numeric"
          :min="BROWSER_DEVICE_DIMENSION_MIN"
          :max="BROWSER_DEVICE_DIMENSION_MAX"
          :readonly="device.profileId !== 'responsive'"
          :aria-label="t('browser.device.height')"
          data-testid="browser-device-height"
          @blur="onDimensionBlur"
          @keydown.enter.prevent="commitDimensions"
        />
      </div>

      <IconButton
        size="sm"
        :label="t('browser.device.rotate')"
        :tooltip="t('browser.device.rotate')"
        data-testid="browser-device-rotate"
        @click="rotate"
      >
        <Icon name="device-rotate" />
      </IconButton>

      <label class="device-toolbar__background" :title="t('browser.device.background')"><span>{{ t('browser.device.background') }}</span><input type="color" :value="background.startsWith('#') ? background : '#f5f5f5'" :aria-label="t('browser.device.background')" @input="emit('backgroundChange', ($event.target as HTMLInputElement).value)" /></label>
      <button ref="backgroundButton" type="button" class="device-toolbar__select" :aria-label="t('browser.device.background')" aria-haspopup="menu" :aria-expanded="backgroundMenu.open.value" @click="backgroundButton && backgroundMenu.toggle(backgroundButton)"><Icon name="chevron-down" /></button>
      <button
        ref="scaleButton"
        class="device-toolbar__select device-toolbar__scale"
        type="button"
        aria-haspopup="menu"
        :aria-expanded="scaleMenu.open.value"
        :aria-label="t('browser.device.scale')"
        data-testid="browser-device-scale"
        @click="toggleScaleMenu"
      >
        <span>{{ scaleLabel }}</span>
        <Icon name="chevron-down" />
      </button>
    </div>

    <IconButton
      class="device-toolbar__close"
      size="sm"
      :label="t('browser.menu.hideDeviceToolbar')"
      :tooltip="t('browser.menu.hideDeviceToolbar')"
      data-testid="browser-device-close"
      @click="void submit({ enabled: false })"
    >
      <Icon name="close" />
    </IconButton>
  </div>
</template>

<style scoped>
.device-toolbar {
  display: flex;
  align-items: center;
  flex: none;
  min-width: 0;
  min-height: var(--space-8);
  padding: var(--space-1) var(--space-2);
  border-bottom: var(--p-hairline) solid var(--color-line);
  background: var(--color-surface-sunken);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  -webkit-app-region: no-drag;
}

.device-toolbar__controls {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}

.device-toolbar__controls::-webkit-scrollbar {
  display: none;
}

.device-toolbar__label,
.device-toolbar__times {
  flex: none;
}

.device-toolbar__dimensions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex: none;
}

.device-toolbar__label {
  color: var(--color-text);
  font-weight: var(--weight-medium);
}

.device-toolbar__select {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-1);
  flex: none;
  height: var(--space-6);
  padding: 0 var(--space-2);
  border: var(--p-hairline) solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  font: inherit;
  cursor: pointer;
  transition: background var(--duration-base) var(--ease-out),
    color var(--duration-base) var(--ease-out);
}

.device-toolbar__select:hover {
  background: var(--color-hover);
  color: var(--color-text);
}

.device-toolbar__select:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}

.device-toolbar__select :deep(svg) {
  width: var(--p-ic-md);
  height: var(--p-ic-md);
}

.device-toolbar__device {
  width: 156px;
}

.device-toolbar__device > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.device-toolbar__dimension {
  flex: none;
  width: 4rem;
  box-shadow: none;
  text-align: center;
}

.device-toolbar__dimension::-webkit-inner-spin-button,
.device-toolbar__dimension::-webkit-outer-spin-button {
  margin: 0;
  appearance: none;
}

.device-toolbar__scale {
  width: 74px;
}

.device-toolbar__close {
  margin-left: var(--space-1);
}
.device-toolbar__background { display: inline-flex; align-items: center; gap: var(--space-1); white-space: nowrap; }
.device-toolbar__background input { width: var(--space-6); height: var(--space-6); padding: 0; border: var(--p-hairline) solid var(--color-line); border-radius: var(--radius-sm); cursor: pointer; }
</style>
