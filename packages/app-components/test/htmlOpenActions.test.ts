// @vitest-environment jsdom
import { createApp, h, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { OpenWithDefaultAppKey } from '@moonshot-ai/app-client/contracts';
import { OpenHtmlFileInPanelKey } from '@moonshot-ai/app-core/contracts';
import HtmlOpenActions from '../src/HtmlOpenActions.vue';

const warnings = vi.hoisted(() => ({ pushWarning: vi.fn() }));
const workspaces = vi.hoisted(() => ({ isLocalWorkspace: true }));
vi.mock('@moonshot-ai/app-client/stores', () => ({
  useWarningsStore: () => warnings,
  workspacesStore: () => workspaces,
}));

let app: App | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  warnings.pushWarning.mockClear();
  workspaces.isLocalWorkspace = true;
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
});

function mount(path: string, options: { openWithDefaultApp?: (path: string) => Promise<boolean>; openInPanel?: (target: { path: string }) => void } = {}) {
  app = createApp({ render: () => h(HtmlOpenActions, { path }) });
  app.use(createKimiI18n({ locale: 'en' }));
  if (options.openWithDefaultApp !== undefined) app.provide(OpenWithDefaultAppKey, options.openWithDefaultApp);
  if (options.openInPanel !== undefined) app.provide(OpenHtmlFileInPanelKey, () => options.openInPanel);
  app.mount(host);
  return host;
}

const SYSTEM_LABEL = 'Open in system browser';
const PANEL_LABEL = 'Open in side panel browser';

describe('HtmlOpenActions', () => {
  it('renders both open actions and routes them to the right target', async () => {
    const openWithDefaultApp = vi.fn(async () => true);
    const openInPanel = vi.fn();
    const el = mount('/work/site/index.html', { openWithDefaultApp, openInPanel });
    const system = el.querySelector<HTMLButtonElement>(`button[aria-label="${SYSTEM_LABEL}"]`);
    const panel = el.querySelector<HTMLButtonElement>(`button[aria-label="${PANEL_LABEL}"]`);
    expect(system).not.toBeNull();
    expect(panel).not.toBeNull();
    system!.click();
    expect(openWithDefaultApp).toHaveBeenCalledWith('/work/site/index.html');
    expect(openInPanel).not.toHaveBeenCalled();
    panel!.click();
    expect(openInPanel).toHaveBeenCalledWith({ path: '/work/site/index.html' });
    expect(openWithDefaultApp).toHaveBeenCalledTimes(1);
  });

  it('hides the side panel action when the panel browser is unavailable', () => {
    const el = mount('/work/site/index.html', { openWithDefaultApp: vi.fn(async () => true), openInPanel: undefined });
    expect(el.querySelector(`button[aria-label="${SYSTEM_LABEL}"]`)).not.toBeNull();
    expect(el.querySelector(`button[aria-label="${PANEL_LABEL}"]`)).toBeNull();
  });

  it('hides both actions in a remote workspace', () => {
    workspaces.isLocalWorkspace = false;
    const el = mount('/work/site/index.html', { openWithDefaultApp: vi.fn(async () => true), openInPanel: vi.fn() });
    expect(el.querySelector(`button[aria-label="${SYSTEM_LABEL}"]`)).toBeNull();
    expect(el.querySelector(`button[aria-label="${PANEL_LABEL}"]`)).toBeNull();
  });

  it('hides both actions for an HTML file whose path the open channels would reject', () => {
    const openInPanel = vi.fn();
    const el = mount('/work/site/template', { openWithDefaultApp: vi.fn(async () => true), openInPanel });
    expect(el.querySelector(`button[aria-label="${SYSTEM_LABEL}"]`)).toBeNull();
    expect(el.querySelector(`button[aria-label="${PANEL_LABEL}"]`)).toBeNull();
    expect(openInPanel).not.toHaveBeenCalled();
  });

  it('warns when the system open fails', async () => {
    const el = mount('/work/site/index.html', { openWithDefaultApp: vi.fn(async () => false) });
    el.querySelector<HTMLButtonElement>(`button[aria-label="${SYSTEM_LABEL}"]`)!.click();
    await vi.waitFor(() => expect(warnings.pushWarning).toHaveBeenCalledOnce());
  });

  it('does not warn when the system open succeeds', async () => {
    const el = mount('/work/site/index.html', { openWithDefaultApp: vi.fn(async () => true) });
    el.querySelector<HTMLButtonElement>(`button[aria-label="${SYSTEM_LABEL}"]`)!.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(warnings.pushWarning).not.toHaveBeenCalled();
  });

  it('renders nothing where neither action is available', () => {
    const el = mount('/work/site/index.html');
    expect(el.querySelector(`button[aria-label="${SYSTEM_LABEL}"]`)).toBeNull();
    expect(el.querySelector(`button[aria-label="${PANEL_LABEL}"]`)).toBeNull();
  });
});
