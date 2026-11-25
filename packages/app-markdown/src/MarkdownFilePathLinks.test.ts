// @vitest-environment jsdom
import { createApp, h, nextTick, shallowRef, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { OpenSessionLinkKey, ResolveImageKey, type ResolveOpenSessionLink } from '@moonshot-ai/app-core/contracts';
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

type Target = { path: string; line?: number; assumed?: boolean };

async function render(
  text: string,
  options: { openFile: (target: Target) => void; resolveFilePath?: (path: string) => { path: string; assumed: boolean } | null; waitFor?: string },
) {
  app = createApp({ render: () => h(Markdown, { text, openFile: options.openFile, resolveFilePath: options.resolveFilePath }) });
  app.use(createKimiI18n({ locale: 'en' }));
  app.mount(host);
  await vi.waitFor(async () => {
    await nextTick();
    expect(host.querySelector(options.waitFor ?? '.md-file-link')).not.toBeNull();
  });
}

function linkWithText(text: string): HTMLElement {
  const links = Array.from(host.querySelectorAll<HTMLElement>('.md-file-link'));
  const link = links.find((el) => el.textContent === text);
  expect(link, `file link with text ${text}`).toBeDefined();
  return link!;
}

function click(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
}

describe('Markdown file path links with resolveFilePath', () => {
  it('opens the context-resolved absolute path and shows it in the tooltip', async () => {
    const openFile = vi.fn();
    await render('查看 package.json 了解详情', {
      openFile,
      resolveFilePath: (path) => (path === 'package.json' ? { path: '/tmp/repro-proj-b/package.json', assumed: false } : null),
    });
    const link = linkWithText('package.json');
    expect(link.title).toBe('/tmp/repro-proj-b/package.json');
    click(link);
    expect(openFile).toHaveBeenCalledTimes(1);
    const target = openFile.mock.calls[0]![0] as Target;
    expect(target.path).toBe('/tmp/repro-proj-b/package.json');
    expect(target.assumed).toBeUndefined();
  });

  it('keeps the relative open target but flags assumed when resolved against cwd', async () => {
    const openFile = vi.fn();
    await render('查看 package.json 了解详情', {
      openFile,
      resolveFilePath: (path) => ({ path: `/ws/a/${path}`, assumed: true }),
    });
    const link = linkWithText('package.json');
    expect(link.title).toBe('/ws/a/package.json');
    click(link);
    const target = openFile.mock.calls[0]![0] as Target;
    expect(target.path).toBe('package.json');
    expect(target.assumed).toBe(true);
  });

  it('leaves target and tooltip untouched when the resolver returns null', async () => {
    const openFile = vi.fn();
    await render('查看 package.json 了解详情', { openFile, resolveFilePath: () => null });
    const link = linkWithText('package.json');
    expect(link.title).toBe('package.json');
    click(link);
    const target = openFile.mock.calls[0]![0] as Target;
    expect(target.path).toBe('package.json');
    expect(target.assumed).toBeUndefined();
  });

  it('does not consult the resolver for absolute paths', async () => {
    const openFile = vi.fn();
    const resolveFilePath = vi.fn(() => null);
    await render('查看 /tmp/repro-proj-b/package.json 了解详情', { openFile, resolveFilePath });
    const link = linkWithText('/tmp/repro-proj-b/package.json');
    expect(resolveFilePath).not.toHaveBeenCalled();
    expect(link.title).toBe('/tmp/repro-proj-b/package.json');
    click(link);
    expect((openFile.mock.calls[0]![0] as Target).path).toBe('/tmp/repro-proj-b/package.json');
  });

  it('opens the complete absolute path when a directory contains spaces', async () => {
    const openFile = vi.fn();
    const resolveFilePath = vi.fn(() => null);
    const path = '/Users/user/projects/test dir/test.md';
    await render(`绝对路径： ${path}`, { openFile, resolveFilePath });
    const link = linkWithText(path);
    expect(resolveFilePath).not.toHaveBeenCalled();
    expect(link.title).toBe(path);
    click(link);
    expect(openFile).toHaveBeenCalledExactlyOnceWith({ path });
  });

  it('behaves as before without a resolveFilePath prop', async () => {
    const openFile = vi.fn();
    await render('查看 resources/kimi/kimi-logo-light.svg 了解详情', { openFile });
    const link = linkWithText('resources/kimi/kimi-logo-light.svg');
    expect(link.title).toBe('resources/kimi/kimi-logo-light.svg');
    click(link);
    const target = openFile.mock.calls[0]![0] as Target;
    expect(target.path).toBe('resources/kimi/kimi-logo-light.svg');
    expect(target.assumed).toBeUndefined();
  });

  it('renders file links as inline spans with button semantics, never real buttons', async () => {
    await render('查看 package.json 了解详情', { openFile: vi.fn() });
    const link = linkWithText('package.json');
    expect(link.tagName).toBe('SPAN');
    expect(link.getAttribute('role')).toBe('button');
    expect(link.tabIndex).toBe(0);
  });

  it('activates file links via Enter and Space keys', async () => {
    const openFile = vi.fn();
    await render('查看 package.json 了解详情', { openFile });
    const link = linkWithText('package.json');
    link.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(openFile).toHaveBeenCalledTimes(1);
    link.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    expect(openFile).toHaveBeenCalledTimes(2);
    link.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(openFile).toHaveBeenCalledTimes(2);
  });

  it('ignores held-key repeat so space/enter cannot open the file twice', async () => {
    const openFile = vi.fn();
    await render('查看 package.json 了解详情', { openFile });
    const link = linkWithText('package.json');
    link.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    link.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', repeat: true, bubbles: true, cancelable: true }));
    link.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', repeat: true, bubbles: true, cancelable: true }));
    expect(openFile).toHaveBeenCalledTimes(1);
  });

  it('resolves explicit markdown file links through the resolver', async () => {
    const openFile = vi.fn();
    await render('详情见 [package.json](package.json)。', {
      openFile,
      resolveFilePath: (path) => (path === 'package.json' ? { path: '/tmp/repro-proj-b/package.json', assumed: false } : null),
      waitFor: 'a.mention-pill',
    });
    const link = host.querySelector<HTMLAnchorElement>('a.mention-pill')!;
    expect(link.dataset.mentionPath).toBe('/tmp/repro-proj-b/package.json');
    click(link);
    expect(openFile).toHaveBeenCalledTimes(1);
    const target = openFile.mock.calls[0]![0] as Target;
    expect(target.path).toBe('/tmp/repro-proj-b/package.json');
    expect(target.assumed).toBeUndefined();
  });

  it('opens the file and line from an explicit colon-suffixed link', async () => {
    const openFile = vi.fn();
    await render('详情见 [情况.md](docs/情况.md:78)。', {
      openFile,
      waitFor: 'a.mention-pill',
    });
    const link = host.querySelector<HTMLAnchorElement>('a.mention-pill')!;
    expect(link.dataset.mentionActionPath).toBe('docs/情况.md');
    click(link);
    expect(openFile).toHaveBeenCalledWith({ path: 'docs/情况.md', line: 78 });
  });

  it('opens a bare extensionless file and line from an explicit link', async () => {
    const openFile = vi.fn();
    await render('详情见 [Makefile](Makefile:10)。', {
      openFile,
      waitFor: 'a.mention-pill',
    });
    const link = host.querySelector<HTMLAnchorElement>('a.mention-pill')!;
    expect(link.dataset.mentionActionPath).toBe('Makefile');
    click(link);
    expect(openFile).toHaveBeenCalledWith({ path: 'Makefile', line: 10 });
  });

  it('flags explicit markdown file links as assumed when resolved against cwd', async () => {
    const openFile = vi.fn();
    await render('详情见 [package.json](package.json)。', {
      openFile,
      resolveFilePath: (path) => ({ path: `/ws/a/${path}`, assumed: true }),
      waitFor: 'a.mention-pill',
    });
    const link = host.querySelector<HTMLAnchorElement>('a.mention-pill')!;
    click(link);
    const target = openFile.mock.calls[0]![0] as Target;
    expect(target.path).toBe('package.json');
    expect(target.assumed).toBe(true);
  });

  it('exposes the cwd-resolved path on assumed explicit links', async () => {
    await render('详情见 [package.json](package.json)。', {
      openFile: vi.fn(),
      resolveFilePath: (path) => ({ path: `/ws/a/${path}`, assumed: true }),
      waitFor: 'a.mention-pill',
    });
    const link = host.querySelector<HTMLAnchorElement>('a.mention-pill')!;
    expect(link.dataset.mentionPath).toBe('/ws/a/package.json');
    expect(link.dataset.mentionActionPath).toBe('/ws/a/package.json');
  });

  it('re-resolves existing links when the resolver changes', async () => {
    const openFile = vi.fn();
    const resolver = shallowRef((_path: string) => ({ path: '/ws/a/package.json', assumed: true }) as { path: string; assumed: boolean } | null);
    app = createApp({
      render: () => h(Markdown, { text: '查看 package.json 了解详情', openFile, resolveFilePath: resolver.value }),
    });
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(host);
    await vi.waitFor(async () => {
      await nextTick();
      expect(host.querySelector('.md-file-link')).not.toBeNull();
    });
    const link = linkWithText('package.json');
    expect(link.title).toBe('/ws/a/package.json');

    resolver.value = (path) => (path === 'package.json' ? { path: '/tmp/repro-proj-b/package.json', assumed: false } : null);
    await vi.waitFor(async () => {
      await nextTick();
      expect(link.title).toBe('/tmp/repro-proj-b/package.json');
    });
    click(link);
    const target = openFile.mock.calls[0]![0] as Target;
    expect(target.path).toBe('/tmp/repro-proj-b/package.json');
    expect(target.assumed).toBeUndefined();
  });

  it('prefers the resolveImage prop over the injected resolver', async () => {
    const injected = vi.fn(async (src: string) => src);
    const prop = vi.fn(async (src: string) => `data:image/svg+xml;base64,PHN2Zy8+`);
    app = createApp({ render: () => h(Markdown, { text: '![logo](resources/kimi/kimi-logo-light.svg)', resolveImage: prop }) });
    app.use(createKimiI18n({ locale: 'en' }));
    app.provide(ResolveImageKey, injected);
    app.mount(host);
    await vi.waitFor(async () => {
      await nextTick();
      expect(prop).toHaveBeenCalledWith('resources/kimi/kimi-logo-light.svg');
    });
    expect(injected).not.toHaveBeenCalled();
  });

  it('re-resolves images when the resolveImage prop changes', async () => {
    const first = vi.fn(async (src: string) => `data:first,${src}`);
    const resolver = shallowRef<(src: string) => Promise<string>>(first);
    app = createApp({ render: () => h(Markdown, { text: '![logo](resources/x.svg)', resolveImage: resolver.value }) });
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(host);
    await vi.waitFor(async () => {
      await nextTick();
      expect(first).toHaveBeenCalledWith('resources/x.svg');
    });
    const second = vi.fn(async (src: string) => `data:second,${src}`);
    resolver.value = second;
    await vi.waitFor(async () => {
      await nextTick();
      expect(second).toHaveBeenCalledWith('resources/x.svg');
    });
    expect(first).toHaveBeenCalledTimes(1);
  });

  it('decodes URL-encoded image sources before resolving', async () => {
    const prop = vi.fn(async (src: string) => `data:image/png;base64,iVBORw0KGgo=`);
    app = createApp({ render: () => h(Markdown, { text: '![logo](assets/My%20Logo.png)', resolveImage: prop }) });
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(host);
    await vi.waitFor(async () => {
      await nextTick();
      expect(prop).toHaveBeenCalledWith('assets/My Logo.png');
    });
  });

  it('decodes the selected variant path from a markdown skill link', async () => {
    await render('[review](kimi-code://skill/review?path=%2Fwork%2FB%2Freview%2FSKILL.md)', {
      openFile: vi.fn(),
      waitFor: 'a.mention-skill',
    });

    const link = host.querySelector<HTMLAnchorElement>('a.mention-skill')!;
    expect(link.dataset.mentionName).toBe('review');
    expect(link.dataset.mentionPath).toBe('/work/B/review/SKILL.md');
  });

  async function renderSessionLink(resolveOpenSessionLink?: ResolveOpenSessionLink, text = 'see [Fix login](kimi-code://sessions/session_1)'): Promise<HTMLAnchorElement> {
    app = createApp({ render: () => h(Markdown, { text }) });
    app.use(createKimiI18n({ locale: 'en' }));
    if (resolveOpenSessionLink !== undefined) app.provide(OpenSessionLinkKey, resolveOpenSessionLink);
    app.mount(host);
    await vi.waitFor(async () => {
      await nextTick();
      expect(host.querySelector('a.mention-session')).not.toBeNull();
    });
    return host.querySelector<HTMLAnchorElement>('a.mention-session')!;
  }

  it('renders a session link as an inert session pill when nothing can open sessions', async () => {
    const link = await renderSessionLink();
    expect(link.hasAttribute('href')).toBe(false);
    expect(link.getAttribute('role')).toBeNull();
    expect(link.dataset.mentionName).toBe('Fix login');
    expect(link.dataset.mentionPath).toBe('session_1');
    expect(link.dataset.mentionActionPath).toBeUndefined();
  });

  it('keeps the session pill inert while the host has session opening switched off', async () => {
    const link = await renderSessionLink(() => undefined);
    expect(link.getAttribute('role')).toBeNull();
    expect(link.hasAttribute('tabindex')).toBe(false);
  });

  it('opens the referenced session from a session pill by click or keyboard', async () => {
    const openSessionLink = vi.fn();
    const link = await renderSessionLink(() => openSessionLink);
    expect(link.hasAttribute('href')).toBe(false);
    expect(link.getAttribute('role')).toBe('button');
    expect(link.tabIndex).toBe(0);

    click(link);
    link.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    link.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true }));
    expect(openSessionLink.mock.calls).toEqual([['session_1'], ['session_1']]);
  });

  it('opens sessions from links written in the earlier <workspaceId>/<sessionId> form', async () => {
    const openSessionLink = vi.fn();
    const link = await renderSessionLink(() => openSessionLink, 'see [Fix login](kimi-code://session/wd_app_0123456789ab/session_1)');
    expect(link.dataset.mentionPath).toBe('session_1');
    click(link);
    expect(openSessionLink).toHaveBeenCalledExactlyOnceWith('session_1');
  });

  it('resolves angle-bracketed image sources containing spaces', async () => {
    const prop = vi.fn(async (src: string) => `data:image/png;base64,iVBORw0KGgo=`);
    app = createApp({ render: () => h(Markdown, { text: '![logo](<KIMI CODE LOGO/Original Logo.png>)', resolveImage: prop }) });
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(host);
    await vi.waitFor(async () => {
      await nextTick();
      expect(prop).toHaveBeenCalledWith('KIMI CODE LOGO/Original Logo.png');
    });
  });
});
