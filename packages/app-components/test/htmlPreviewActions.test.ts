// @vitest-environment jsdom
import { createApp, h, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { OpenWithDefaultAppKey } from '@moonshot-ai/app-client/contracts';
import { OpenHtmlFileInPanelKey } from '@moonshot-ai/app-core/contracts';
import type { FileData, TurnFileChange } from '@moonshot-ai/app-core/client/types';
import FilePreview from '../src/FilePreview.vue';
import TurnDiffPanel from '../src/chat/TurnDiffPanel.vue';

vi.mock('@moonshot-ai/app-markdown', () => ({
  Markdown: { template: '<div />' },
}));

const workspaceLocation = vi.hoisted(() => ({ local: { value: true } }));
vi.mock('@moonshot-ai/app-client/stores', () => ({
  useWarningsStore: () => ({ pushWarning: () => {} }),
  workspacesStore: () => ({ isLocalWorkspace: workspaceLocation.local.value }),
}));

let app: App | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  workspaceLocation.local.value = true;
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  vi.unstubAllGlobals();
});

const SYSTEM_LABEL = 'Open in system browser';
const PANEL_LABEL = 'Open in side panel browser';

function mount(component: object, props: Record<string, unknown>, injections: { openWithDefaultApp?: (path: string) => Promise<boolean>; openInPanel?: (target: { path: string }) => void } = {}) {
  app = createApp({ render: () => h(component, props) });
  app.use(createKimiI18n({ locale: 'en' }));
  if (injections.openWithDefaultApp !== undefined) app.provide(OpenWithDefaultAppKey, injections.openWithDefaultApp);
  if (injections.openInPanel !== undefined) app.provide(OpenHtmlFileInPanelKey, () => injections.openInPanel);
  app.mount(host);
  return host;
}

function htmlFile(path = '/work/site/index.html'): FileData {
  return { path, content: '<h1>Hi</h1>', encoding: 'utf-8', mime: 'text/html', isBinary: false, size: 12 };
}

describe('file preview toolbar', () => {
  it('shows both open actions for an HTML file and routes them with its path', () => {
    const openWithDefaultApp = vi.fn(async () => true);
    const openInPanel = vi.fn();
    const el = mount(FilePreview, { file: htmlFile(), loading: false }, { openWithDefaultApp, openInPanel });
    const system = el.querySelector<HTMLButtonElement>(`button[aria-label="${SYSTEM_LABEL}"]`);
    const panel = el.querySelector<HTMLButtonElement>(`button[aria-label="${PANEL_LABEL}"]`);
    expect(system).not.toBeNull();
    expect(panel).not.toBeNull();
    system!.click();
    expect(openWithDefaultApp).toHaveBeenCalledWith('/work/site/index.html');
    panel!.click();
    expect(openInPanel).toHaveBeenCalledWith({ path: '/work/site/index.html' });
  });

  it('shows no open actions for an HTML file on a remote device', () => {
    workspaceLocation.local.value = false;
    const el = mount(FilePreview, { file: htmlFile(), loading: false }, { openWithDefaultApp: vi.fn(async () => true), openInPanel: vi.fn() });
    expect(el.querySelector(`button[aria-label="${SYSTEM_LABEL}"]`)).toBeNull();
    expect(el.querySelector(`button[aria-label="${PANEL_LABEL}"]`)).toBeNull();
  });

  it('shows no open actions for a non-HTML file', () => {
    const el = mount(FilePreview, { file: { ...htmlFile('/work/src/main.ts'), mime: 'text/plain', languageId: 'typescript' }, loading: false }, { openWithDefaultApp: vi.fn(async () => true), openInPanel: vi.fn() });
    expect(el.querySelector(`button[aria-label="${SYSTEM_LABEL}"]`)).toBeNull();
    expect(el.querySelector(`button[aria-label="${PANEL_LABEL}"]`)).toBeNull();
  });

  it('shows no open actions for an HTML file without an HTML extension', () => {
    const openInPanel = vi.fn();
    const el = mount(FilePreview, { file: { ...htmlFile('/work/site/template'), languageId: 'html' }, loading: false }, { openWithDefaultApp: vi.fn(async () => true), openInPanel });
    expect(el.querySelector(`button[aria-label="${SYSTEM_LABEL}"]`)).toBeNull();
    expect(el.querySelector(`button[aria-label="${PANEL_LABEL}"]`)).toBeNull();
    expect(openInPanel).not.toHaveBeenCalled();
  });
});

describe('turn diff toolbar', () => {
  const change: TurnFileChange = { path: 'site/index.html', added: 3, removed: 1 };

  it('shows both open actions for an HTML change and routes them with the absolute path', () => {
    const openWithDefaultApp = vi.fn(async () => true);
    const openInPanel = vi.fn();
    const el = mount(TurnDiffPanel, { change, cwd: '/work' }, { openWithDefaultApp, openInPanel });
    const system = el.querySelector<HTMLButtonElement>(`button[aria-label="${SYSTEM_LABEL}"]`);
    const panel = el.querySelector<HTMLButtonElement>(`button[aria-label="${PANEL_LABEL}"]`);
    expect(system).not.toBeNull();
    expect(panel).not.toBeNull();
    system!.click();
    expect(openWithDefaultApp).toHaveBeenCalledWith('/work/site/index.html');
    panel!.click();
    expect(openInPanel).toHaveBeenCalledWith({ path: '/work/site/index.html' });
  });

  it('shows no open actions for an HTML change on a remote device', () => {
    workspaceLocation.local.value = false;
    const el = mount(TurnDiffPanel, { change, cwd: '/srv' }, { openWithDefaultApp: vi.fn(async () => true), openInPanel: vi.fn() });
    expect(el.querySelector(`button[aria-label="${SYSTEM_LABEL}"]`)).toBeNull();
    expect(el.querySelector(`button[aria-label="${PANEL_LABEL}"]`)).toBeNull();
  });

  it('shows no open actions for a non-HTML change', () => {
    const el = mount(TurnDiffPanel, { change: { path: 'src/main.ts', added: 1, removed: 0 }, cwd: '/work' }, { openWithDefaultApp: vi.fn(async () => true), openInPanel: vi.fn() });
    expect(el.querySelector(`button[aria-label="${SYSTEM_LABEL}"]`)).toBeNull();
    expect(el.querySelector(`button[aria-label="${PANEL_LABEL}"]`)).toBeNull();
  });
});
