import { createRenderer, defineComponent, h, ssrContextKey } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import BrowserOverlayMenu from '../../src/renderer/components/browser-overlay/BrowserOverlayMenu.vue';

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

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


it.each([{ isComposing: true, keyCode: 27 }, { isComposing: false, keyCode: 229 }])('preserves annotation comments during IME keyboard events %j', (composition) => {
  const dismiss = vi.fn();
  class Textarea {}
  for (const name of ['HTMLButtonElement', 'HTMLAnchorElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement']) vi.stubGlobal(name, Textarea);
  vi.stubGlobal('navigator', { platform: 'MacIntel' });
  vi.stubGlobal('window', { cancelAnimationFrame() {}, clearTimeout() {}, addEventListener() {}, removeEventListener() {}, kimiBrowserOverlay: { ready() {}, onConfig: () => () => {}, onShown: () => () => {}, onHide: () => () => {}, dismiss } });
  let state!: { config: { value: unknown }; onKeydown: (event: unknown) => void };
  const app = renderer.createApp(defineComponent(() => {
    state = (BrowserOverlayMenu as unknown as { setup: (props: unknown, context: unknown) => typeof state }).setup({}, { expose() {} });
    return () => h('div');
  }));
  app.provide(ssrContextKey, {});
  app.mount({ children: [], props: {} });
  state.config.value = { kind: 'dialog', requestId: 1, annotation: {}, input: { value: '已有长评论' } };
  for (const key of ['Escape', 'Enter', 'ArrowDown']) state.onKeydown({ key, ...composition, target: new Textarea(), preventDefault() {} });
  expect(dismiss).not.toHaveBeenCalled();
  state.onKeydown({ key: 'Escape', isComposing: false, keyCode: 27, preventDefault() {} });
  expect(dismiss).toHaveBeenCalledExactlyOnceWith({ requestId: 1, reason: 'escape' });
  app.unmount();
});

it('cycles keyboard focus inside a focused dialog', () => {
  vi.stubGlobal('navigator', { platform: 'MacIntel' });
  vi.stubGlobal('window', { cancelAnimationFrame() {}, clearTimeout() {}, addEventListener() {}, removeEventListener() {}, kimiBrowserOverlay: { ready() {}, onConfig: () => () => {}, onShown: () => () => {}, onHide: () => () => {} } });
  const buttons = Array.from({ length: 3 }, () => ({ focus: vi.fn(), getClientRects: () => [{}] }));
  const document = { activeElement: buttons[2] };
  vi.stubGlobal('document', document);
  let state!: { config: { value: unknown }; dialogRef: { value: unknown }; onKeydown: (event: unknown) => void };
  const app = renderer.createApp(defineComponent(() => {
    state = (BrowserOverlayMenu as unknown as { setup: (props: unknown, context: unknown) => typeof state }).setup({}, { expose() {} });
    return () => h('div');
  }));
  app.provide(ssrContextKey, {});
  app.mount({ children: [], props: {} });
  state.config.value = { kind: 'dialog', requestId: 1, preserveFocus: false, dismissible: false };
  state.dialogRef.value = { querySelectorAll: () => buttons };
  const preventDefault = vi.fn();
  state.onKeydown({ key: 'Tab', preventDefault });
  expect(buttons[0]!.focus).toHaveBeenCalledOnce();
  document.activeElement = buttons[0];
  state.onKeydown({ key: 'Tab', shiftKey: true, preventDefault });
  expect(buttons[2]!.focus).toHaveBeenCalledOnce();
  expect(preventDefault).toHaveBeenCalledTimes(2);
  app.unmount();
});
