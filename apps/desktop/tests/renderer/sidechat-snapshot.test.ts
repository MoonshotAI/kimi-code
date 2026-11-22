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
const panelScroll = vi.hoisted(() => ({ follow: vi.fn(), hold: vi.fn() }));
vi.mock('@moonshot-ai/app-client/composables', async () => {
  const { ref } = await import('vue');
  return {
    usePanelScroll: () => ({ scroller: ref(null), dock: ref(null), showJump: ref(false), following: ref(true), onScroll: vi.fn(), follow: panelScroll.follow, hold: panelScroll.hold }),
    useEscInterrupt: () => ({ armed: ref(false), press: vi.fn(), reset: vi.fn() }),
  };
});
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

it('follows to the bottom once when the user sends a message and leaves a later scroll-up alone', async () => {
  const { state, app } = mountPanel({ running: false, sending: false });
  panelScroll.follow.mockClear();
  const payload = { text: 'hi', restoreText: 'hi', attachments: [], restoreEntries: [] };
  const promise = state.onComposerSubmit(payload);
  expect(panelScroll.follow).toHaveBeenCalledTimes(1);
  await promise;
  await nextTick();
  expect(panelScroll.follow).toHaveBeenCalledTimes(1);
  app.unmount();
});

it('follows to the bottom once when resuming a failed turn and leaves a later scroll-up alone', async () => {
  const { state, app } = mountPanel({ running: false, sending: false });
  panelScroll.follow.mockClear();
  state.onResumeTurn();
  expect(panelScroll.follow).toHaveBeenCalledTimes(1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  expect(panelScroll.follow).toHaveBeenCalledTimes(1);
  app.unmount();
});

it('jumps back to the bottom from the pill through the panel scroll controller', () => {
  const { state, app } = mountPanel({ running: false, sending: false });
  panelScroll.follow.mockClear();
  state.jumpToBottom();
  expect(panelScroll.follow).toHaveBeenCalledTimes(1);
  app.unmount();
});
