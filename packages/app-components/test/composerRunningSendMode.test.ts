// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clientState = vi.hoisted(() => ({
  activeSessionId: null as null | { value: string | null },
  activity: null as null | { value: string },
  working: null as null | { value: boolean },
  environment: null as null | { value: string },
}));

vi.mock('@moonshot-ai/app-client/client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const vue = await import('vue');
  clientState.activeSessionId = vue.ref<string | null>('sess-1');
  clientState.activity = vue.ref('idle');
  clientState.working = vue.ref(false);
  clientState.environment = vue.ref('local');
  return {
    ...actual,
    useKimiWebClient: () => ({
      activeSessionId: clientState.activeSessionId!,
      activeWorkspaceId: vue.ref('ws-1'),
      activity: clientState.activity!,
      working: clientState.working!,
      activeSessionEnvironment: clientState.environment!,
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
import { createComposerSnapshot, textToDoc } from '@moonshot-ai/app-composer/model';

let app: App | undefined;
let host: HTMLDivElement;
let storage: Map<string, string>;

beforeEach(() => {
  storage = new Map<string, string>();
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
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  host.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function mountFreshComposer(locale: 'zh' | 'en' = 'zh') {
  const [{ default: Composer }, { useAppDialogs, useRunningSendMode }] = await Promise.all([
    import('../src/composer/Composer.vue'),
    import('@moonshot-ai/app-client/composables'),
  ]);
  let composerRef!: InstanceType<typeof Composer>;
  let dialogs!: ReturnType<typeof useAppDialogs>;
  let runningMode!: ReturnType<typeof useRunningSendMode>;
  const submits: Array<Record<string, unknown>> = [];
  const steers: Array<Record<string, unknown>> = [];
  const commands: Array<Record<string, unknown>> = [];
  app = createApp({
    setup() {
      dialogs = useAppDialogs();
      runningMode = useRunningSendMode();
      return () => h(Composer, {
        ref: (value) => { composerRef = value as InstanceType<typeof Composer>; },
        onSubmit: (payload: Record<string, unknown>) => submits.push(payload),
        onSteer: (payload: Record<string, unknown>) => steers.push(payload),
        onCommand: (payload: Record<string, unknown>) => commands.push(payload),
      });
    },
  });
  app.use(createKimiI18n({ locale }));
  app.mount(host);
  await nextTick();
  return {
    setDraft: (value: string) => {
      composerRef.loadForEdit(value, createComposerSnapshot(textToDoc(value), [], []));
    },
    submits,
    steers,
    commands,
    dialogs,
    runningMode,
  };
}

function pressKey(el: Element, init: KeyboardEventInit): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
}

describe('Composer running send mode and first-time steer tip', () => {
  it('steers by default while running, shows the tip once, and deep-links Settings to agent tab', async () => {
    const warnSpy = vi.spyOn(console, 'warn');
    const { setDraft, submits, steers, dialogs } = await mountFreshComposer('zh');
    clientState.activity!.value = 'running';
    clientState.working!.value = true;
    await nextTick();
    dialogs.showSettings.value = false;
    dialogs.settingsInitialTab.value = undefined;

    const input = host.querySelector('[aria-label="消息输入框"]')!;
    expect(input.getAttribute('aria-placeholder')).toContain('输入会立即插入运行中的回合');
    expect(host.querySelector('.composer-tip')).toBeNull();

    setDraft('改成用 TypeScript');
    await nextTick();
    pressKey(input, { key: 'Enter' });
    await nextTick();

    expect(steers).toHaveLength(1);
    expect(steers[0]?.text).toBe('改成用 TypeScript');
    expect(submits).toHaveLength(0);

    const tip = host.querySelector('.composer-tip');
    expect(tip).not.toBeNull();
    expect(tip?.textContent).toContain('运行中发送现默认立即插入当前回合');
    expect(storage.get('kimi-web.running-send-steer-tip-seen')).toBe('1');

    const settingsBtn = tip!.querySelector<HTMLButtonElement>('.composer-tip-link')!;
    expect(settingsBtn.textContent).toBe('设置');
    settingsBtn.click();
    await nextTick();

    expect(host.querySelector('.composer-tip')).toBeNull();
    expect(dialogs.showSettings.value).toBe(true);
    expect(dialogs.settingsInitialTab.value).toBe('agent');
    expect(dialogs.settingsHighlightKey.value).toBe('running-send-mode');
    expect(warnSpy).not.toHaveBeenCalled();

    dialogs.showSettings.value = false;
    await nextTick();
    expect(dialogs.settingsHighlightKey.value).toBeUndefined();

    setDraft('第二条引导');
    await nextTick();
    pressKey(input, { key: 'Enter' });
    await nextTick();

    expect(steers).toHaveLength(2);
    expect(host.querySelector('.composer-tip')).toBeNull();
  });

  it('queues with Mod+Enter while running in steer mode without triggering the tip', async () => {
    const { setDraft, submits, steers } = await mountFreshComposer('en');
    clientState.activity!.value = 'running';
    clientState.working!.value = true;
    await nextTick();

    const input = host.querySelector('[aria-label="Message input"]')!;
    setDraft('Queue this for the next turn');
    await nextTick();
    pressKey(input, { key: 'Enter', metaKey: true });
    await nextTick();

    expect(steers).toHaveLength(0);
    expect(submits).toHaveLength(1);
    expect(submits[0]).toMatchObject({
      text: 'Queue this for the next turn',
      forceQueue: true,
    });
    expect(host.querySelector('.composer-tip')).toBeNull();
  });

  it('queues on Enter and steers on Mod+Enter when set to queue mode', async () => {
    storage.set('kimi-web.running-send-mode', 'queue');
    const { setDraft, submits, steers } = await mountFreshComposer('en');
    clientState.activity!.value = 'running';
    clientState.working!.value = true;
    await nextTick();

    const input = host.querySelector('[aria-label="Message input"]')!;
    expect(input.getAttribute('aria-placeholder')).toContain('Press Enter to queue');

    setDraft('First queued item');
    await nextTick();
    pressKey(input, { key: 'Enter' });
    await nextTick();

    expect(submits).toHaveLength(1);
    expect(submits[0]).toMatchObject({
      text: 'First queued item',
      forceQueue: true,
    });
    expect(steers).toHaveLength(0);
    expect(host.querySelector('.composer-tip')).toBeNull();

    setDraft('Immediate steer item');
    await nextTick();
    pressKey(input, { key: 'Enter', ctrlKey: true });
    await nextTick();

    expect(steers).toHaveLength(1);
    expect(steers[0]?.text).toBe('Immediate steer item');
  });

  it('formats the running steer placeholder Mod key as ⌘ on macOS and Ctrl on other platforms', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    await mountFreshComposer('en');
    clientState.activity!.value = 'running';
    clientState.working!.value = true;
    await nextTick();

    const macInput = host.querySelector('[aria-label="Message input"]')!;
    expect(macInput.getAttribute('aria-placeholder')).toContain('⌘+Enter to queue');

    app?.unmount();
    app = undefined;
    host.innerHTML = '';
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
    await mountFreshComposer('en');
    clientState.activity!.value = 'running';
    clientState.working!.value = true;
    await nextTick();

    const winInput = host.querySelector('[aria-label="Message input"]')!;
    expect(winInput.getAttribute('aria-placeholder')).toContain('Ctrl+Enter to queue');
  });

  it('routes main-session prompt commands through running steer/queue modes while keeping /btw side-scoped', async () => {
    const { setDraft, submits, steers, commands, runningMode } = await mountFreshComposer('en');
    clientState.activity!.value = 'running';
    clientState.working!.value = true;
    await nextTick();

    const input = host.querySelector('[aria-label="Message input"]')!;

    setDraft('/swarm inspect parallel');
    await nextTick();
    pressKey(input, { key: 'Enter' });
    await nextTick();

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      cmd: '/swarm inspect parallel',
      delivery: 'steer',
    });
    expect(host.querySelector('.composer-tip')).not.toBeNull();

    setDraft('/goal ship release');
    await nextTick();
    pressKey(input, { key: 'Enter', metaKey: true });
    await nextTick();

    expect(commands).toHaveLength(2);
    expect(commands[1]).toMatchObject({
      cmd: '/goal ship release',
      delivery: 'queue',
    });

    setDraft('/btw check logs');
    await nextTick();
    pressKey(input, { key: 'Enter', metaKey: true });
    await nextTick();
    expect(commands).toHaveLength(2);

    pressKey(input, { key: 'Enter' });
    await nextTick();
    expect(commands).toHaveLength(3);
    expect(commands[2]).toMatchObject({ cmd: '/btw check logs' });
    expect(commands[2]?.delivery).toBeUndefined();

    runningMode.setRunningSendMode('queue');
    await nextTick();

    setDraft('/swarm queued swarm');
    await nextTick();
    pressKey(input, { key: 'Enter' });
    await nextTick();

    expect(commands).toHaveLength(4);
    expect(commands[3]).toMatchObject({
      cmd: '/swarm queued swarm',
      delivery: 'queue',
    });

    setDraft('/goal steered goal');
    await nextTick();
    pressKey(input, { key: 'Enter', ctrlKey: true });
    await nextTick();

    expect(commands).toHaveLength(5);
    expect(commands[4]).toMatchObject({
      cmd: '/goal steered goal',
      delivery: 'steer',
    });
    expect(submits).toHaveLength(0);
    expect(steers).toHaveLength(0);
  });

  it('offers stop while the session worktree is being set up and still submits new messages', async () => {
    const { setDraft, submits, steers } = await mountFreshComposer('en');
    clientState.activity!.value = 'idle';
    clientState.working!.value = false;
    clientState.environment!.value = 'local';
    await nextTick();
    expect(host.querySelector('button.stop')).toBeNull();

    clientState.environment!.value = 'settingUp';
    await nextTick();
    expect(host.querySelector('button.stop')?.getAttribute('aria-label')).toBe('Interrupt');

    const input = host.querySelector('[aria-label="Message input"]')!;
    setDraft('one more thing');
    await nextTick();
    pressKey(input, { key: 'Enter' });
    await nextTick();
    expect(steers).toHaveLength(0);
    expect(submits).toHaveLength(1);
    expect(submits[0]).toMatchObject({ text: 'one more thing' });
    expect(submits[0]?.forceQueue).toBeUndefined();

    clientState.environment!.value = 'local';
    await nextTick();
    expect(host.querySelector('button.stop')).toBeNull();
  });
});
