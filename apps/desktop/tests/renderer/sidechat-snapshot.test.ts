import { createRenderer, defineComponent, nextTick, ssrContextKey } from 'vue';
import { expect, it, vi } from 'vitest';
import SideChatPanel from '../../../../packages/app-components/src/chat/SideChatPanel.vue';

const persist = vi.hoisted(() => vi.fn());
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../../../../packages/app-components/src/chat/ChatPane.vue', () => ({ default: {} }));
vi.mock('../../../../packages/app-components/src/chat/WorkingIndicator.vue', () => ({ default: {} }));
vi.mock('../../../../packages/app-components/src/composer/Composer.vue', () => ({ default: {} }));
vi.mock('@moonshot-ai/app-client/client', () => ({ sideChatDrafts: new Map() }));
vi.mock('@moonshot-ai/app-client/lib', () => ({ persistComposerDraftSnapshot: persist }));
const renderer = createRenderer<any, any>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null });

it.each([true, false])('preserves the submitted snapshot when the editor remains mounted: %s', async mounted => {
  persist.mockClear();
  const snapshot = { version: 1, doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Reference' }] }] }, attachments: [], attachmentOrder: [] };
  const payload = { text: 'Reference', restoreText: 'Reference', attachments: [], restoreEntries: [], snapshot };
  const onSend = vi.fn(async () => false);
  const loadForEdit = vi.fn();
  const restoreDraftEntries = vi.fn();
  let state: any;
  const app = renderer.createApp(defineComponent(() => {
    state = (SideChatPanel as any).setup({ turns: [], running: false, sending: false, agentId: 'side', onSend }, { expose() {}, emit() {} });
    return () => null;
  }));
  app.provide(ssrContextKey, {});
  app.mount({});
  state.composerRef.value = mounted ? { isEmpty: () => true, loadForEdit, restoreDraftEntries } : null;
  await state.onComposerSubmit(payload);
  expect(onSend).toHaveBeenCalledWith('Reference', [], snapshot);
  if (mounted) expect(loadForEdit).toHaveBeenCalledWith('Reference', snapshot);
  else expect(persist).toHaveBeenCalledWith('sidechat:side', 'Reference', [], snapshot);
  expect(restoreDraftEntries).not.toHaveBeenCalled();
  app.unmount();
});

it.each([{ running: true, sending: false }, { running: false, sending: true }])('restores the draft without sending while the side chat is busy: %o', async flags => {
  persist.mockClear();
  const snapshot = { version: 1, doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Reference' }] }] }, attachments: [], attachmentOrder: [] };
  const payload = { text: 'Reference', restoreText: 'Reference', attachments: [], restoreEntries: [], snapshot };
  const onSend = vi.fn(async () => true);
  let state: any;
  const app = renderer.createApp(defineComponent(() => {
    state = (SideChatPanel as any).setup({ turns: [], ...flags, agentId: 'side', onSend }, { expose() {}, emit() {} });
    return () => null;
  }));
  app.provide(ssrContextKey, {});
  app.mount({});
  state.composerRef.value = null;
  await state.onComposerSubmit(payload);
  expect(onSend).not.toHaveBeenCalled();
  expect(persist).toHaveBeenCalledWith('sidechat:side', 'Reference', [], snapshot);
  app.unmount();
});

function mountPanel(flags: { running: boolean; sending: boolean }, onSend = vi.fn(async () => true)) {
  let state: any;
  const app = renderer.createApp(defineComponent(() => {
    state = (SideChatPanel as any).setup({ turns: [], ...flags, agentId: 'side', onSend }, { expose() {}, emit() {} });
    return () => null;
  }));
  app.provide(ssrContextKey, {});
  app.mount({});
  return { state: state as any, app };
}

async function bindScroller(state: any, el: { scrollTop: number; scrollHeight: number; clientHeight: number }) {
  state.bodyRef.value = el;
  await nextTick();
  await nextTick();
}

it('shows the back-to-bottom pill when scrolled far up and hides it after jumping back', async () => {
  const { state, app } = mountPanel({ running: true, sending: false });
  const el = { scrollTop: 800, scrollHeight: 1000, clientHeight: 200 };
  await bindScroller(state, el);
  expect(el.scrollTop).toBe(1000);

  el.scrollTop = 400;
  state.onBodyScroll();
  expect(state.showJump.value).toBe(true);

  state.jumpToBottom();
  expect(el.scrollTop).toBe(1000);
  expect(state.showJump.value).toBe(false);
  app.unmount();
});

it('hides the pill on a small departure and re-follows at the bottom', async () => {
  const { state, app } = mountPanel({ running: true, sending: false });
  const el = { scrollTop: 800, scrollHeight: 1000, clientHeight: 200 };
  await bindScroller(state, el);

  el.scrollTop = 700;
  state.onBodyScroll();
  expect(state.showJump.value).toBe(false);

  el.scrollTop = 400;
  state.onBodyScroll();
  expect(state.showJump.value).toBe(true);

  el.scrollTop = 800;
  state.onBodyScroll();
  expect(state.showJump.value).toBe(false);
  app.unmount();
});

it('re-pins to the bottom immediately when the user sends a message', async () => {
  const { state, app } = mountPanel({ running: false, sending: false });
  const el = { scrollTop: 800, scrollHeight: 1000, clientHeight: 200 };
  await bindScroller(state, el);
  el.scrollTop = 400;
  state.onBodyScroll();
  expect(state.showJump.value).toBe(true);

  const payload = { text: 'hi', restoreText: 'hi', attachments: [], restoreEntries: [] };
  const promise = state.onComposerSubmit(payload);
  expect(el.scrollTop).toBe(1000);
  expect(state.showJump.value).toBe(false);
  await promise;
  app.unmount();
});

it('does not override a scroll-up that happens while a send is in flight', async () => {
  const { state, app } = mountPanel({ running: false, sending: false });
  const el = { scrollTop: 800, scrollHeight: 1000, clientHeight: 200 };
  await bindScroller(state, el);
  el.scrollTop = 400;
  state.onBodyScroll();

  const payload = { text: 'hi', restoreText: 'hi', attachments: [], restoreEntries: [] };
  const promise = state.onComposerSubmit(payload);
  expect(el.scrollTop).toBe(1000);

  el.scrollTop = 400;
  state.onBodyScroll();
  expect(state.showJump.value).toBe(true);

  await promise;
  await nextTick();
  expect(el.scrollTop).toBe(400);
  expect(state.showJump.value).toBe(true);
  app.unmount();
});

it('re-pins to the bottom immediately when resuming a failed turn', async () => {
  const { state, app } = mountPanel({ running: false, sending: false });
  const el = { scrollTop: 800, scrollHeight: 1000, clientHeight: 200 };
  await bindScroller(state, el);
  el.scrollTop = 400;
  state.onBodyScroll();
  expect(state.showJump.value).toBe(true);

  state.onResumeTurn();
  expect(el.scrollTop).toBe(1000);
  expect(state.showJump.value).toBe(false);
  app.unmount();
});

it('does not override a scroll-up that happens while the resume request is in flight', async () => {
  const { state, app } = mountPanel({ running: false, sending: false });
  const el = { scrollTop: 800, scrollHeight: 1000, clientHeight: 200 };
  await bindScroller(state, el);
  el.scrollTop = 400;
  state.onBodyScroll();

  state.onResumeTurn();
  expect(el.scrollTop).toBe(1000);

  el.scrollTop = 400;
  state.onBodyScroll();
  expect(state.showJump.value).toBe(true);

  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  expect(el.scrollTop).toBe(400);
  expect(state.showJump.value).toBe(true);
  app.unmount();
});

it('keeps the pinned anchor element stationary when disclosures toggle', () => {
  const { state, app } = mountPanel({ running: true, sending: false });
  const el = { scrollTop: 500, scrollHeight: 1000, clientHeight: 200 };
  state.bodyRef.value = el;
  let anchorTop = 300;
  const anchor = { getBoundingClientRect: () => ({ top: anchorTop }) };
  let rafCallback: FrameRequestCallback | null = null;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { rafCallback = cb; return 1; });

  state.pinScrollAnchor(anchor);
  anchorTop = 180;
  rafCallback!(0);
  expect(el.scrollTop).toBe(380);

  vi.unstubAllGlobals();
  app.unmount();
});
