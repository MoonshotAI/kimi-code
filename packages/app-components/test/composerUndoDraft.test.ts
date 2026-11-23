// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clientState = vi.hoisted(() => ({
  activeSessionId: null as null | { value: string | null },
}));

vi.mock('@moonshot-ai/app-client/client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const vue = await import('vue');
  clientState.activeSessionId = vue.ref<string | null>(null);
  return {
    ...actual,
    useKimiWebClient: () => ({
      activeSessionId: clientState.activeSessionId!,
      activeWorkspaceId: vue.ref('ws-1'),
      activity: vue.ref('idle'),
      working: vue.ref(false),
      isStartingFirstPrompt: vue.ref(false),
      queued: vue.ref([]),
      searchFiles: vi.fn(async () => []),
      uploadImage: vi.fn(),
      status: vue.ref({}),
      thinking: vue.ref('high'),
      planMode: vue.ref(false),
      planArmed: vue.ref(false),
      swarmMode: vue.ref(false),
      towerMode: vue.ref(false),
      goalMode: vue.ref(false),
      goal: vue.ref(null),
      activationBadges: vue.ref([]),
      models: vue.ref([]),
      starredModelIds: vue.ref([]),
      recentModelIds: vue.ref([]),
      skills: vue.ref([]),
      skillsLoaded: vue.ref(true),
      chatGateVerdict: vue.ref(null),
      experimentalFlags: vue.ref({}),
      notify: vi.fn(),
      toggleGoalMode: vi.fn(),
      togglePlanMode: vi.fn(),
      toggleSwarmMode: vi.fn(),
      toggleTowerMode: vi.fn(),
      setThinking: vi.fn(),
      setPermission: vi.fn(),
      selectModel: vi.fn(),
    }),
  };
});

import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { composerSchema, createComposerSnapshot, textToDoc, type ComposerDocumentSnapshot } from '@moonshot-ai/app-composer/model';
import { createComposerEditor } from '@moonshot-ai/app-composer/runtime';
import Composer from '../src/composer/Composer.vue';

const LONG_TEXT = '撤回后必须保留的大段输入\n'.repeat(200);
let app: App | undefined;
let host: HTMLDivElement;
let composer: InstanceType<typeof Composer>;

function mountComposer(deferSubmitReset = false): void {
  app = createApp({
    render: () => h(Composer, {
      ref: (value) => { composer = value as InstanceType<typeof Composer>; },
      deferSubmitReset,
    }),
  });
  app.use(createKimiI18n({ locale: 'zh' }));
  app.mount(host);
}

function inputText(): string {
  return host.querySelector('[aria-label="消息输入框"]')?.textContent ?? '';
}

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, String(value)); },
    removeItem: (key: string) => { storage.delete(key); },
    clear: () => storage.clear(),
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() { return storage.size; },
  });
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => ({ font: '', measureText: (text: string) => ({ width: text.length * 8 }) }),
  });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  clientState.activeSessionId!.value = null;
  host = document.createElement('div');
  document.body.append(host);
  mountComposer();
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  host.remove();
  vi.unstubAllGlobals();
});

describe('undo draft across session switches', () => {
  it('clears a deferred composer only when dispatch is confirmed', async () => {
    app?.unmount();
    mountComposer(true);
    const submitted = createComposerSnapshot(textToDoc('保留到真正发送'), [], []);
    composer.loadForEdit('保留到真正发送', submitted);
    await nextTick();

    const input = host.querySelector('[aria-label="消息输入框"]')!;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await nextTick();
    expect(inputText()).toBe('保留到真正发送');

    composer.clearAfterDispatch(submitted);
    await nextTick();
    expect(inputText()).toBe('');
  });

  it('keeps newer input when a deferred dispatch finishes', async () => {
    app?.unmount();
    mountComposer(true);
    const submitted = createComposerSnapshot(textToDoc('第一条'), [], []);
    composer.loadForEdit('第一条', submitted);
    await nextTick();
    host.querySelector('[aria-label="消息输入框"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await nextTick();

    composer.loadForEdit('下一条', createComposerSnapshot(textToDoc('下一条'), [], []));
    await nextTick();
    composer.clearAfterDispatch(submitted);
    await nextTick();

    expect(inputText()).toBe('下一条');
  });

  it('keeps browser reference edits made while a deferred dispatch finishes', async () => {
    app?.unmount();
    mountComposer(true);
    const doc = composerSchema.nodes.doc.create(null, composerSchema.nodes.paragraph.create(null, composerSchema.nodes.browser_reference.create({ refId: 'ref-1', label: 'Page' })));
    const current = createComposerSnapshot(doc, [], [], { references: [{ id: 'ref-1', captureId: 'cap-1', comment: 'new comment', includeScreenshot: false }], captures: [] });
    const submitted = { ...current, browserReferences: [{ id: 'ref-1', captureId: 'cap-1', comment: 'old comment', includeScreenshot: true }] };
    composer.loadForEdit('', current);
    await nextTick();

    composer.clearAfterDispatch(submitted);
    await nextTick();

    expect(inputText()).toContain('Page');
  });

  it.each([null, 'created-session'])('keeps the recalled snapshot when the first session scope is %s', async (firstScope) => {
    clientState.activeSessionId!.value = firstScope;
    await nextTick();
    const snapshot = createComposerSnapshot(textToDoc(LONG_TEXT), [], []);
    composer.loadForEdit(LONG_TEXT, snapshot);
    await nextTick();
    expect(inputText()).toContain('撤回后必须保留的大段输入');

    clientState.activeSessionId!.value = 'other-session';
    await vi.waitFor(() => expect(inputText()).not.toContain('撤回后必须保留的大段输入'));

    clientState.activeSessionId!.value = firstScope;
    await vi.waitFor(() => expect(inputText()).toContain('撤回后必须保留的大段输入'));
  });

  it('keeps the recalled text when undo swaps the docked composer for the empty-session composer', async () => {
    app?.unmount();
    const hasTurns = ref(true);
    let current: { loadForEdit: (value: string, snapshot?: ComposerDocumentSnapshot) => void } | null = null;
    app = createApp({
      render: () => h(Composer, {
        key: hasTurns.value ? 'docked' : 'empty',
        ref: (value) => { if (value) current = value as { loadForEdit: (value: string, snapshot?: ComposerDocumentSnapshot) => void }; },
      }),
    });
    app.use(createKimiI18n({ locale: 'zh' }));
    clientState.activeSessionId!.value = 'created-session';
    app.mount(host);
    await nextTick();

    hasTurns.value = false;
    await nextTick();
    const snapshot = createComposerSnapshot(textToDoc(LONG_TEXT), [], []);
    current!.loadForEdit(LONG_TEXT, snapshot);
    await nextTick();
    expect(inputText()).toContain('撤回后必须保留的大段输入');

    clientState.activeSessionId!.value = 'other-session';
    hasTurns.value = true;
    await nextTick();
    expect(inputText()).not.toContain('撤回后必须保留的大段输入');

    clientState.activeSessionId!.value = 'created-session';
    hasTurns.value = false;
    await nextTick();
    expect(inputText()).toContain('撤回后必须保留的大段输入');
  });

  it.each([null, 'created-session'])('does not restore an older empty editor stash after a programmatic recall in scope %s', async (firstScope) => {
    const scope = firstScope ?? '__new__';
    clientState.activeSessionId!.value = firstScope;
    await nextTick();
    const staleHost = document.createElement('div');
    host.append(staleHost);
    const stale = createComposerEditor(staleHost, {
      initialText: '',
      onChange: () => {},
      handleKeyDown: () => false,
    });
    stale.stashState(scope);
    stale.destroy();
    staleHost.remove();

    composer.loadForEdit(LONG_TEXT, createComposerSnapshot(textToDoc(LONG_TEXT), [], []));
    await nextTick();

    const probeHost = document.createElement('div');
    host.append(probeHost);
    const probe = createComposerEditor(probeHost, {
      initialText: '',
      onChange: () => {},
      handleKeyDown: () => false,
    });
    expect(probe.restoreState(scope)).toBe(false);
    expect(probe.getText()).toBe('');
    expect(localStorage.getItem(`kimi-web.draft-snapshot.${scope}`)).toContain('撤回后必须保留的大段输入');
    probe.destroy();
    probeHost.remove();
  });
});
