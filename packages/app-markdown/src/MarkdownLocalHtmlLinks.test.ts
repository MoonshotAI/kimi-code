// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { OpenFileLinkKey, OpenLocalHtmlFileKey, type OpenFileLink } from '@moonshot-ai/app-core/contracts';
import Markdown from './Markdown.vue';

vi.mock('markstream-vue', async (importOriginal) => ({
  ...await importOriginal<typeof import('markstream-vue')>(),
  enableKatex: () => {},
  enableMermaid: () => {},
}));
vi.mock('./lib/markdownWorkers', () => ({ ensureMarkdownWorkers: () => {} }));

let app: App | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
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

async function render(text: string, options: { openLocalHtml?: (url: string) => void; openFile?: (target: { path: string }) => void; openFileLink?: OpenFileLink }) {
  app = createApp({ render: () => h(Markdown, { text, openFile: options.openFile }) });
  app.use(createKimiI18n({ locale: 'en' }));
  if (options.openLocalHtml !== undefined) app.provide(OpenLocalHtmlFileKey, () => options.openLocalHtml);
  if (options.openFileLink !== undefined) app.provide(OpenFileLinkKey, options.openFileLink);
  app.mount(host);
  await vi.waitFor(async () => {
    await nextTick();
    expect(host.querySelector('a')).not.toBeNull();
  });
}

function click(link: Element): { defaultPrevented: boolean } {
  let reached = false;
  let preventedBefore = false;
  const record = (event: Event) => {
    reached = true;
    preventedBefore = event.defaultPrevented;
    event.preventDefault();
  };
  document.addEventListener('click', record);
  const notCancelled = link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  document.removeEventListener('click', record);
  return { defaultPrevented: reached ? preventedBefore : !notCancelled };
}

it('opens a file URL HTML link through the desktop browser instead of navigating the window', async () => {
  const openLocalHtml = vi.fn();
  await render('[report](file:///Users/me/site/index.html)', { openLocalHtml });
  const event = click(host.querySelector('a[href^="file:"]')!);
  expect(event.defaultPrevented).toBe(true);
  expect(openLocalHtml).toHaveBeenCalledWith('file:///Users/me/site/index.html');
});

it('leaves file URL links untouched where no local HTML opener is provided', async () => {
  await render('[report](file:///Users/me/site/index.html)', {});
  const event = click(host.querySelector('a[href^="file:"]')!);
  expect(event.defaultPrevented).toBe(false);
});

it('opens a non-HTML file URL link in the file preview', async () => {
  const openLocalHtml = vi.fn();
  const openFile = vi.fn();
  await render('[notes](file:///Users/me/My%20Notes/todo.md)', { openLocalHtml, openFile });
  const event = click(host.querySelector('a[href^="file:"]')!);
  expect(event.defaultPrevented).toBe(true);
  expect(openFile).toHaveBeenCalledWith({ path: '/Users/me/My Notes/todo.md' });
  expect(openLocalHtml).not.toHaveBeenCalled();
});

it('hands a non-HTML file URL link to the host file link hook', async () => {
  const openFile = vi.fn();
  const openFileLink = vi.fn<OpenFileLink>();
  await render('[notes](file:///Users/me/todo.md)', { openLocalHtml: vi.fn(), openFile, openFileLink });
  click(host.querySelector('a[href^="file:"]')!);
  expect(openFileLink).toHaveBeenCalledWith({ path: '/Users/me/todo.md' }, openFile);
  expect(openFile).not.toHaveBeenCalled();
});

it('leaves non-HTML file URL links alone where the app cannot open local files', async () => {
  const openFile = vi.fn();
  await render('[notes](file:///Users/me/todo.md)', { openFile });
  const event = click(host.querySelector('a[href^="file:"]')!);
  expect(event.defaultPrevented).toBe(false);
  expect(openFile).not.toHaveBeenCalled();
});

it('routes workspace-relative HTML links through openFile like other file links', async () => {
  const openLocalHtml = vi.fn();
  const openFile = vi.fn();
  await render('[site](site/index.html)', { openLocalHtml, openFile });
  await vi.waitFor(() => expect(host.querySelector('.mention-pill')).not.toBeNull());
  const event = click(host.querySelector('.mention-pill')!);
  expect(event.defaultPrevented).toBe(true);
  expect(openFile).toHaveBeenCalledWith({ path: 'site/index.html' });
  expect(openLocalHtml).not.toHaveBeenCalled();
});

it('hands file link clicks to the host file link hook with openFile as the fallback', async () => {
  const openFile = vi.fn();
  const openFileLink = vi.fn<OpenFileLink>();
  await render('[site](site/index.html)', { openFile, openFileLink });
  await vi.waitFor(() => expect(host.querySelector('.mention-pill')).not.toBeNull());
  click(host.querySelector('.mention-pill')!);
  expect(openFileLink).toHaveBeenCalledWith({ path: 'site/index.html' }, openFile);
  expect(openFile).not.toHaveBeenCalled();
});

it('keeps the query and fragment of a workspace-relative HTML link', async () => {
  const openFile = vi.fn();
  const openFileLink = vi.fn<OpenFileLink>();
  await render('[site](site/index.html?tab=2#intro)', { openFile, openFileLink });
  await vi.waitFor(() => expect(host.querySelector('.mention-pill')).not.toBeNull());
  click(host.querySelector('.mention-pill')!);
  expect(openFileLink).toHaveBeenCalledWith({ path: 'site/index.html', urlSuffix: '?tab=2#intro' }, openFile);
  expect(openFile).not.toHaveBeenCalled();
});
