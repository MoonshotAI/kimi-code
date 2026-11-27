import { createRenderer, defineComponent, h, nextTick, ref, ssrContextKey } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import { copyTextToClipboard } from '@moonshot-ai/app-core/lib';
import ChatHeader from '../../src/renderer/components/chat/ChatHeader.vue';
import type { BrowserOverlayMenuRegistration } from '../../src/renderer/lib/browserOverlayMenu';
const mocks = vi.hoisted(() => ({ client: null as unknown, archive: vi.fn(), reload: vi.fn(), registration: null as BrowserOverlayMenuRegistration | null, sessionLinks: true }));
vi.mock('vue-i18n',()=>({useI18n:()=>({t:(k:string)=>k})}));
vi.mock('../../src/renderer/lib/browserOverlayMenu',()=>({registerBrowserOverlayMenu:(r: BrowserOverlayMenuRegistration)=>{mocks.registration=r;return {available:true,open:ref(false),close(){},refresh(){}}}}));
vi.mock('@moonshot-ai/app-core/lib',async(importOriginal)=>({sessionLink:(await importOriginal<typeof import('@moonshot-ai/app-core/lib')>()).sessionLink,copyTextToClipboard:vi.fn(),sessionLinksSupported:()=>mocks.sessionLinks,isMacosDesktop:true,safeGetJson:vi.fn(()=>null),safeSetJson:vi.fn(),STORAGE_KEYS:{shortcutOverrides:'kimi.shortcutOverrides'}}));
vi.mock('@moonshot-ai/app-core/composables',()=>({useSidebarTabs:()=>({sidebarTabs:ref(false)})}));
vi.mock('@moonshot-ai/app-components',()=>({OpenInMenu:{}}));
vi.mock('@moonshot-ai/app-client/contracts',()=>({track(){}}));
vi.mock('@moonshot-ai/app-client/client',()=>({useKimiWebClient:()=>mocks.client}));
vi.mock('@moonshot-ai/app-client/stores',()=>({sessionViewsStore:()=>({activeSessionTitle:'A',activeSessionPinned:false}),workspacesStore:()=>({isLocalWorkspace:true})}));
vi.mock('@moonshot-ai/app-client/panel',()=>({panelApiKey:Symbol()}));
vi.mock('../../src/renderer/composables/useNativeTerminal',()=>({useNativeTerminal:()=>({})}));
vi.mock('@moonshot-ai/app-ui',()=>({Icon:{},IconButton:{},Menu:{},MenuItem:{},Tooltip:{},useImeComposition:()=>({})}));
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


it('rejects old session menu actions after switching and reopening another context', async () => {
  const client = { activeSessionId: ref('A'), activeSessionArchived: ref(false), visibleWorkspace: ref(null), activeSessionEnvironment: ref('local'), status: ref({}), gitInfo: ref(null), gitDiffStats: ref(null), activePullRequest: ref(null), archiveSessionWithToast: mocks.archive };
  mocks.client = client;
  vi.stubGlobal('document', { removeEventListener() {} });
  vi.stubGlobal('window', { removeEventListener() {} });
  const app = renderer.createApp(defineComponent(() => {
    (ChatHeader as unknown as { setup: (props: unknown, context: unknown) => unknown }).setup({}, { expose() {}, emit() {} });
    return () => h('div');
  }));
  app.provide(ssrContextKey, {});
  app.mount({ children: [], props: {} });
  const menu = mocks.registration!;
  const archiveId = () => {
    const item = menu.items().find(item => item.kind === 'item' && item.label === 'header.archiveSession');
    if (item?.kind !== 'item') throw new Error('Missing archive action');
    return item.id;
  };
  const oldId = archiveId();
  client.activeSessionId.value = 'B';
  await nextTick();
  const newId = archiveId();
  menu.onSelect(oldId);
  expect(mocks.archive).not.toHaveBeenCalled();
  menu.onSelect(newId);
  expect(mocks.archive).toHaveBeenCalledExactlyOnceWith('B');
  client.activeSessionId.value = 'A';
  await nextTick();
  menu.onSelect(oldId);
  expect(mocks.archive).toHaveBeenCalledTimes(1);
  app.unmount();
});

function mountHeader() {
  const client = { activeSessionId: ref('A'), activeSessionArchived: ref(false), visibleWorkspace: ref(null), activeSessionEnvironment: ref('local'), status: ref({}), gitInfo: ref(null), gitDiffStats: ref(null), activePullRequest: ref(null), archiveSessionWithToast: mocks.archive, reloadSession: mocks.reload };
  mocks.client = client;
  vi.stubGlobal('document', { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  const app = renderer.createApp(defineComponent(() => {
    (ChatHeader as unknown as { setup: (props: unknown, context: unknown) => unknown }).setup({}, { expose() {}, emit() {} });
    return () => h('div');
  }));
  app.provide(ssrContextKey, {});
  app.mount({ children: [], props: {} });
  return { app, menu: mocks.registration! };
}

it('groups session actions and keeps copy items open', () => {
  const { app, menu } = mountHeader();
  const items = menu.items();
  const itemIds = items.filter(item => item.kind === 'item').map(item => {
    if (item.kind !== 'item') throw new Error('expected item');
    return item.id.slice(item.id.indexOf(':') + 1);
  });
  expect(itemIds).toEqual(['rename', 'pin', 'fork', 'copy-all', 'copy-summary', 'copy-id', 'copy-link', 'export', 'reload', 'archive']);
  expect(items.filter(item => item.kind === 'separator')).toHaveLength(2);
  for (const item of items) {
    if (item.kind !== 'item') continue;
    const action = item.id.slice(item.id.indexOf(':') + 1);
    if (action === 'copy-all' || action === 'copy-summary' || action === 'copy-id' || action === 'copy-link') {
      expect(item.keepOpen).toBe(true);
    } else {
      expect(item.keepOpen).toBeUndefined();
    }
  }
  app.unmount();
});

it('copies the session deep link from the menu', () => {
  vi.mocked(copyTextToClipboard).mockResolvedValue(true);
  const { app, menu } = mountHeader();
  const item = menu.items().find(item => item.kind === 'item' && item.label === 'header.copySessionLink');
  if (item?.kind !== 'item') throw new Error('Missing copy link action');
  menu.onSelect(item.id);
  expect(copyTextToClipboard).toHaveBeenCalledExactlyOnceWith('kimi-code://sessions/A');
  app.unmount();
});

it('leaves the session link out of the menu when this build cannot open session links', () => {
  mocks.sessionLinks = false;
  try {
    const { app, menu } = mountHeader();
    expect(menu.items().some(item => item.kind === 'item' && item.label === 'header.copySessionLink')).toBe(false);
    expect(menu.items().some(item => item.kind === 'item' && item.label === 'header.copySessionId')).toBe(true);
    app.unmount();
  } finally {
    mocks.sessionLinks = true;
  }
});

it('reloads the session from the menu and hides the item when archived', async () => {
  const { app, menu } = mountHeader();
  const reloadId = () => {
    const item = menu.items().find(item => item.kind === 'item' && item.label === 'header.reloadSession');
    return item?.kind === 'item' ? item.id : undefined;
  };
  const id = reloadId();
  expect(id).toBeDefined();
  menu.onSelect(id!);
  expect(mocks.reload).toHaveBeenCalledExactlyOnceWith('A');
  (mocks.client as { activeSessionArchived: { value: boolean } }).activeSessionArchived.value = true;
  await nextTick();
  expect(reloadId()).toBeUndefined();
  app.unmount();
});
