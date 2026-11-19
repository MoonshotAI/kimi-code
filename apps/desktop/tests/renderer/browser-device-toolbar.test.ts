import { createRenderer, defineComponent, h, nextTick, reactive, ref, ssrContextKey } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import BrowserDeviceToolbar from '../../src/renderer/components/browser/BrowserDeviceToolbar.vue';
import type { BrowserDeviceModeRequest } from '../../src/shared/browser-device';

const menus = vi.hoisted(() => new Map<string, { onSelect: (id: string) => void }>());

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../../src/renderer/lib/browserOverlayMenu', () => ({ registerBrowserOverlayMenu: (registration: { id: string; onSelect: (id: string) => void }) => { menus.set(registration.id, registration); return { open: ref(false) }; } }));

interface HostNode {
  tag?: string;
  children: HostNode[];
  props: Record<string, unknown>;
  parent?: HostNode;
}
const renderer = createRenderer<HostNode, HostNode>({
  patchProp: (node, key, _previous, next) => { node.props[key] = next; },
  insert: (node, parent) => { node.parent = parent; parent.children.push(node); },
  remove: () => {},
  createElement: (tag) => ({ tag, children: [], props: {}, select() {}, getBoundingClientRect: () => ({ x: 0, y: 0, width: 400, height: 30 }) }),
  createText: () => ({ children: [], props: {} }),
  createComment: () => ({ children: [], props: {} }),
  setText: () => {}, setElementText: () => {},
  parentNode: (node) => node.parent ?? null, nextSibling: () => null,
  setScopeId: () => {},
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });


it.each([false, true])('preserves responsive edits across pending requests (failure=%s)', async (failure) => {
  vi.stubGlobal('document', { activeElement: null });
  const updates: BrowserDeviceModeRequest[] = [];
  const pending: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  const updateDeviceMode = (request: BrowserDeviceModeRequest) => {
    updates.push(request);
    return new Promise<void>((resolve, reject) => pending.push({ resolve, reject }));
  };
  const props = reactive({ updateDeviceMode, browserId: 'test', background: 'auto', device: {
    enabled: true, profileId: 'responsive', orientation: 'portrait', width: 393, height: 852,
    scaleMode: 'fit', displayScale: 1, requestedScale: 1, maxDisplayScale: 1,
  } });
  let state!: { widthDraft: { value: string }; heightDraft: { value: string }; onDimensionBlur: () => void; rotate: () => void };
  const app = renderer.createApp(defineComponent(() => {
    state = (BrowserDeviceToolbar as unknown as { setup: (props: unknown, context: unknown) => typeof state }).setup(props, {
      expose() {}, emit: (_name: string, value: BrowserDeviceModeRequest) => updates.push(value),
    });
    return () => h('div');
  }));
  app.provide(ssrContextKey, {});
  app.mount({ children: [], props: {} });
  state.widthDraft.value = '500';
  state.onDimensionBlur();
  await Promise.resolve();
  expect(updates.at(-1)).toMatchObject({ width: 500, height: 852 });
  state.rotate();
  expect(updates.at(-1)).toMatchObject({ width: 852, height: 500, orientation: 'landscape' });
  menus.get('browser.device.scale.test')!.onSelect('scale-0.5');
  expect(updates.at(-1)).toMatchObject({ profileId: 'responsive', width: 852, height: 500, orientation: 'landscape', scaleMode: 'fixed', scale: 0.5 });
  state.rotate();
  expect(updates.at(-1)).toMatchObject({ width: 500, height: 852, orientation: 'portrait' });
  state.widthDraft.value = '600';
  props.device = { ...props.device, width: 852, height: 500, orientation: 'landscape' };
  await nextTick();
  expect(state.widthDraft.value).toBe('600');
  props.device = { ...props.device, width: 500, height: 852, orientation: 'portrait' };
  for (const task of pending.splice(0)) {
    if (failure) task.reject(new Error('update failed'));
    else task.resolve();
  }
  await nextTick();
  await nextTick();
  expect(state.widthDraft.value).toBe('600');
  state.onDimensionBlur();
  await Promise.resolve();
  expect(updates.at(-1)).toMatchObject({ width: 600 });
  state.widthDraft.value = '500';
  state.onDimensionBlur();
  await Promise.resolve();
  expect(updates.at(-1)).toMatchObject({ width: 500 });
  for (const task of pending.splice(0)) task.resolve();
  await nextTick();
  await nextTick();
  state.widthDraft.value = '700';
  props.device = { ...props.device, profileId: 'pixel-8', width: 412, height: 915 };
  await nextTick();
  expect(state.widthDraft.value).toBe('412');
  menus.get('browser.device.profile.test')!.onSelect('iphone-16');
  state.rotate();
  menus.get('browser.device.scale.test')!.onSelect('scale-0.5');
  expect(updates.at(-1)).toMatchObject({ profileId: 'iphone-16', orientation: 'landscape', scaleMode: 'fixed', scale: 0.5 });
  for (const task of pending.splice(0)) task.resolve();
  await nextTick();
  await nextTick();
  menus.get('browser.device.profile.test')!.onSelect('responsive');
  const responsive = updates.at(-1)!;
  if (!responsive.enabled || responsive.profileId !== 'responsive') throw new Error('Expected responsive request');
  state.rotate();
  expect(updates.at(-1)).toMatchObject({ profileId: 'responsive', width: responsive.height, height: responsive.width });
  for (const task of pending.splice(0)) task.resolve();
  await nextTick();
  await nextTick();
  app.unmount();
});
