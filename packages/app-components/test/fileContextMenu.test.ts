// @vitest-environment jsdom
import { createApp, h, type App } from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const lib = vi.hoisted(() => ({ copy: vi.fn<(text: string) => Promise<boolean>>() }));
const workspaceLocation = vi.hoisted(() => ({ local: { value: true } }));

vi.mock('@moonshot-ai/app-core/lib', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  copyTextToClipboard: (text: string) => lib.copy(text),
}));
vi.mock('@moonshot-ai/app-client/stores', () => ({
  useWarningsStore: () => ({ pushWarning: vi.fn() }),
  workspacesStore: () => ({ isLocalWorkspace: workspaceLocation.local.value }),
}));

import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { OpenInServiceKey, OpenWithDefaultAppKey, RevealInFolderKey, type OpenInService } from '@moonshot-ai/app-client/contracts';
import FileContextMenuHost from '../src/chat/FileContextMenuHost.vue';
import {
  closeFileContextMenu,
  isAbsoluteFilePath,
  openFileContextMenu,
  resolveFileMenuPath,
  useFileContextMenuState,
} from '../src/chat/fileContextMenu';

const state = useFileContextMenuState();
let app: App | null = null;

function rightClickOn(el: Element, cwd?: string, x = 40, y = 50): void {
  const event = new MouseEvent('contextmenu', { bubbles: true, clientX: x, clientY: y });
  el.dispatchEvent(event);
  openFileContextMenu(event, cwd);
}

beforeEach(() => {
  workspaceLocation.local.value = true;
  lib.copy.mockReset().mockResolvedValue(true);
  document.body.innerHTML = '';
});

afterEach(() => {
  closeFileContextMenu();
  app?.unmount();
  app = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  window.innerWidth = 1024;
  window.innerHeight = 768;
});

function openInServiceStub(): { service: OpenInService; catalog: ReturnType<typeof vi.fn>; open: ReturnType<typeof vi.fn> } {
  const catalog = vi.fn(async () => [
    { id: 'typora', label: 'Typora' },
    { id: 'vscode', label: 'VS Code' },
    { id: 'finder', label: 'Finder' },
  ]);
  const open = vi.fn(async () => true);
  return {
    service: {
      catalog,
      open,
      icon: (appId) => appId === 'typora' ? 'typora.png' : '',
    },
    catalog,
    open,
  };
}

function mountHost(
  reveal?: (path: string) => Promise<boolean>,
  openWithDefaultApp?: (path: string) => Promise<boolean>,
  openInService?: OpenInService,
): void {
  app = createApp({ render: () => h(FileContextMenuHost) });
  app.use(createKimiI18n({ locale: 'en' }));
  if (reveal !== undefined) app.provide(RevealInFolderKey, reveal);
  if (openWithDefaultApp !== undefined) app.provide(OpenWithDefaultAppKey, openWithDefaultApp);
  if (openInService !== undefined) app.provide(OpenInServiceKey, openInService);
  app.mount(document.createElement('div'));
}

function menuEl(): HTMLElement | null {
  return document.body.querySelector('.file-context-menu');
}

function submenuEl(): HTMLElement | null {
  return document.body.querySelector('.file-context-submenu');
}

function menuTexts(): string[] {
  return [...(menuEl()?.querySelectorAll('[role="menuitem"], .ui-menu-item, li, button') ?? [])].map((el) =>
    (el.textContent ?? '').trim(),
  );
}

function submenuTexts(): string[] {
  return [...(submenuEl()?.querySelectorAll('[role="menuitem"], .ui-menu-item, li, button') ?? [])].map((el) =>
    (el.textContent ?? '').trim(),
  );
}

function menuItem(container: HTMLElement, label: string): HTMLElement {
  return [...container.querySelectorAll<HTMLElement>('*')].filter((el) => (el.textContent ?? '').trim() === label).at(-1)!;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

it('isAbsoluteFilePath covers posix, windows and UNC forms', () => {
  expect(isAbsoluteFilePath('/tmp/a.ts')).toBe(true);
  expect(isAbsoluteFilePath('C:\\src\\a.ts')).toBe(true);
  expect(isAbsoluteFilePath('D:/src/a.ts')).toBe(true);
  expect(isAbsoluteFilePath('\\\\server\\share\\a.ts')).toBe(true);
  expect(isAbsoluteFilePath('src/a.ts')).toBe(false);
  expect(isAbsoluteFilePath('')).toBe(false);
});

it('resolveFileMenuPath joins relative paths against cwd', () => {
  expect(resolveFileMenuPath('/tmp/a.ts', '/repo')).toBe('/tmp/a.ts');
  expect(resolveFileMenuPath('src/a.ts', '/repo')).toBe('/repo/src/a.ts');
  expect(resolveFileMenuPath('src/a.ts', '/repo/')).toBe('/repo/src/a.ts');
  expect(resolveFileMenuPath('src/a.ts')).toBe('src/a.ts');
  expect(resolveFileMenuPath('src/a.ts', 'C:\\repo')).toBe('C:\\repo\\src\\a.ts');
});

it('resolveFileMenuPath returns native Windows paths without changing POSIX paths', () => {
  expect(resolveFileMenuPath('D:\\work/notes.md')).toBe('D:\\work\\notes.md');
  expect(resolveFileMenuPath('project/notes.md', 'C:\\work')).toBe('C:\\work\\project\\notes.md');
  expect(resolveFileMenuPath('project/notes.md', '//server/share')).toBe('\\\\server\\share\\project\\notes.md');
  expect(resolveFileMenuPath('/tmp/a.ts', '/repo')).toBe('/tmp/a.ts');
  expect(resolveFileMenuPath('src/a.ts', '/repo')).toBe('/repo/src/a.ts');
});

it('opens from a data-file-path element and prevents the default menu', () => {
  const host = document.createElement('div');
  host.innerHTML = '<button data-file-path="/tmp/a.ts">a.ts</button>';
  document.body.append(host);
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 20 });
  const button = host.querySelector('button')!;
  button.dispatchEvent(event);
  openFileContextMenu(event, '/repo');
  expect(event.defaultPrevented).toBe(true);
  expect(state.open).toBe(true);
  expect(state.path).toBe('/tmp/a.ts');
  expect(state.cwd).toBe('/repo');
  expect(state.x).toBe(10);
  expect(state.y).toBe(20);
});

it('opens from a mention pill outside the editor', () => {
  const host = document.createElement('div');
  host.innerHTML = '<span class="mention-pill" data-mention-path="src/b.ts"><span class="mention-pill-name">b.ts</span></span>';
  document.body.append(host);
  rightClickOn(host.querySelector('.mention-pill-name')!, '/repo');
  expect(state.open).toBe(true);
  expect(state.path).toBe('src/b.ts');
});

it('skips skill mention pills but keeps file and folder mentions', () => {
  const host = document.createElement('div');
  host.innerHTML =
    '<span class="mention-pill" data-mention-kind="skill" data-mention-path="/skills/review/SKILL.md">review</span>' +
    '<span class="mention-pill" data-mention-kind="file" data-mention-path="src/f.ts">f.ts</span>' +
    '<span class="mention-pill" data-mention-kind="folder" data-mention-path="src">src</span>';
  document.body.append(host);
  rightClickOn(host.children[0]!);
  expect(state.open).toBe(false);
  rightClickOn(host.children[1]!);
  expect(state.open).toBe(true);
  expect(state.path).toBe('src/f.ts');
  closeFileContextMenu();
  rightClickOn(host.children[2]!);
  expect(state.open).toBe(true);
  expect(state.path).toBe('src');
});

it('prefers data-mention-action-path over data-mention-path', () => {
  const host = document.createElement('div');
  host.innerHTML =
    '<span class="mention-pill" data-mention-kind="file" data-mention-path="site/index.html?tab=2#intro" data-mention-action-path="site/index.html">index.html</span>';
  document.body.append(host);
  rightClickOn(host.querySelector('.mention-pill')!);
  expect(state.open).toBe(true);
  expect(state.path).toBe('site/index.html');
});

it('preserves leading and trailing spaces in paths', () => {
  const host = document.createElement('div');
  host.innerHTML = '<button data-file-path="/tmp/report.txt ">report.txt</button>';
  document.body.append(host);
  rightClickOn(host.querySelector('button')!);
  expect(state.open).toBe(true);
  expect(state.path).toBe('/tmp/report.txt ');
});

it('hides host actions for files on a remote device', async () => {
  workspaceLocation.local.value = false;
  const { service } = openInServiceStub();
  mountHost(vi.fn<(path: string) => Promise<boolean>>().mockResolvedValue(true), vi.fn<(path: string) => Promise<boolean>>().mockResolvedValue(true), service);
  const host = document.createElement('div');
  host.innerHTML = '<button data-file-path="/srv/app/README.md">README.md</button>';
  document.body.append(host);
  rightClickOn(host.querySelector('button')!);
  await flush();
  const items = menuTexts().join('|');
  expect(items).toContain('Copy path');
  expect(items).not.toContain('Reveal in folder');
  expect(items).not.toContain('Open with');
});

it('hides reveal for deleted files but still offers copy', async () => {
  const reveal = vi.fn<(path: string) => Promise<boolean>>().mockResolvedValue(true);
  mountHost(reveal);
  const host = document.createElement('div');
  host.innerHTML =
    '<button data-file-path="/repo/gone.ts" data-file-deleted>gone.ts</button>' +
    '<button data-file-path="/repo/alive.ts">alive.ts</button>';
  document.body.append(host);
  const [gone, alive] = host.querySelectorAll('button');

  rightClickOn(gone!);
  await flush();
  expect(state.deleted).toBe(true);
  expect(menuTexts().join('|')).not.toContain('Reveal in folder');
  expect(menuTexts().join('|')).toContain('Copy path');

  rightClickOn(alive!);
  await flush();
  expect(state.deleted).toBe(false);
  expect(menuTexts().join('|')).toContain('Reveal in folder');
});

it('opens from a Markdown auto-detected file link', () => {
  const host = document.createElement('div');
  host.innerHTML = '<p>看 <button type="button" class="md-file-link" data-file-path="src/foo.ts">src/foo.ts:10</button> 这里</p>';
  document.body.append(host);
  rightClickOn(host.querySelector('.md-file-link')!, '/repo');
  expect(state.open).toBe(true);
  expect(state.path).toBe('src/foo.ts');
});

it('ignores mention pills inside ProseMirror and elements without a path', () => {
  const host = document.createElement('div');
  host.innerHTML =
    '<div class="ProseMirror"><span class="mention-pill" data-mention-path="src/c.ts">c.ts</span></div>' +
    '<span class="plain">nothing</span>' +
    '<button data-file-path="">empty</button>';
  document.body.append(host);
  for (const el of host.querySelectorAll('.mention-pill, .plain, button')) {
    rightClickOn(el);
    expect(state.open).toBe(false);
  }
});

it('shows only copy when reveal is not provided', async () => {
  mountHost();
  const host = document.createElement('div');
  host.innerHTML = '<button data-file-path="/tmp/a.ts">a.ts</button>';
  document.body.append(host);
  rightClickOn(host.querySelector('button')!);
  await flush();
  expect(menuTexts().join('|')).toContain('Copy path');
  expect(menuTexts().join('|')).not.toContain('Reveal in folder');
});

it('reveals the resolved path through the injected handler', async () => {
  const reveal = vi.fn<(path: string) => Promise<boolean>>().mockResolvedValue(true);
  mountHost(reveal);
  const host = document.createElement('div');
  host.innerHTML = '<span class="mention-pill" data-mention-path="src/b.ts">b.ts</span>';
  document.body.append(host);
  rightClickOn(host.querySelector('.mention-pill')!, '/repo');
  await flush();
  const texts = menuTexts().join('|');
  expect(texts).toContain('Reveal in folder');
  const item = [...menuEl()!.querySelectorAll('*')].find((el) => (el.textContent ?? '').trim() === 'Reveal in folder')!;
  (item as HTMLElement).click();
  await flush();
  expect(reveal).toHaveBeenCalledWith('/repo/src/b.ts');
  expect(state.open).toBe(false);
});

it('copies the resolved path and closes', async () => {
  mountHost();
  const host = document.createElement('div');
  host.innerHTML = '<button data-file-path="src/a.ts">a.ts</button>';
  document.body.append(host);
  rightClickOn(host.querySelector('button')!, '/repo');
  await flush();
  const item = [...menuEl()!.querySelectorAll('*')].find((el) => (el.textContent ?? '').trim() === 'Copy path')!;
  (item as HTMLElement).click();
  await flush();
  expect(lib.copy).toHaveBeenCalledWith('/repo/src/a.ts');
  expect(state.open).toBe(false);
});

it('closes on Escape and on outside pointer', async () => {
  mountHost();
  const host = document.createElement('div');
  host.innerHTML = '<button data-file-path="/tmp/a.ts">a.ts</button>';
  document.body.append(host);
  rightClickOn(host.querySelector('button')!);
  await flush();
  expect(menuEl()).not.toBeNull();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  expect(state.open).toBe(false);

  rightClickOn(host.querySelector('button')!);
  await flush();
  expect(menuEl()).not.toBeNull();
  document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  expect(state.open).toBe(false);
});

it('repositions when another file is right-clicked while open', async () => {
  mountHost();
  const host = document.createElement('div');
  host.innerHTML = '<button data-file-path="/tmp/a.ts">a.ts</button><button data-file-path="/tmp/b.ts">b.ts</button>';
  document.body.append(host);
  const [a, b] = host.querySelectorAll('button');
  rightClickOn(a!, undefined, 10, 20);
  await flush();
  expect(state.path).toBe('/tmp/a.ts');

  rightClickOn(b!, undefined, 300, 200);
  await flush();
  expect(state.path).toBe('/tmp/b.ts');
  expect(menuEl()!.style.left).toBe('300px');
  expect(menuEl()!.style.top).toBe('200px');
});

it.each(['md', 'markdown', 'mdx', 'MD'])('opens a .%s file with the default app from the submenu', async (ext) => {
  const openWithDefaultApp = vi.fn<(path: string) => Promise<boolean>>().mockResolvedValue(true);
  const { service, catalog, open } = openInServiceStub();
  mountHost(undefined, openWithDefaultApp, service);
  const host = document.createElement('div');
  host.innerHTML = `<button data-file-path="docs/README.${ext}">README.${ext}</button>`;
  document.body.append(host);
  rightClickOn(host.querySelector('button')!, '/repo');
  await flush();
  expect(menuTexts().join('|')).toContain('Open with');
  expect(menuTexts().join('|')).toContain('Copy path');
  expect(menuTexts().join('|')).not.toContain('Open in default app');
  menuItem(menuEl()!, 'Open with').click();
  await flush();
  expect(catalog).toHaveBeenCalledWith('file', `/repo/docs/README.${ext}`);
  expect(submenuTexts()[0]).toBe('Open in default app');
  expect(submenuTexts()).not.toContain('Finder');
  menuItem(submenuEl()!, 'Open in default app').click();
  await flush();
  expect(openWithDefaultApp).toHaveBeenCalledWith(`/repo/docs/README.${ext}`);
  expect(open).not.toHaveBeenCalled();
  expect(state.open).toBe(false);
});

it('opens a selected detected app only for this invocation', async () => {
  const openWithDefaultApp = vi.fn<(path: string) => Promise<boolean>>().mockResolvedValue(true);
  const { service, open } = openInServiceStub();
  mountHost(undefined, openWithDefaultApp, service);
  const host = document.createElement('div');
  host.innerHTML = '<button data-file-path="/tmp/notes.md">notes.md</button>';
  document.body.append(host);
  rightClickOn(host.querySelector('button')!);
  await flush();
  menuItem(menuEl()!, 'Open with').click();
  await flush();
  expect(submenuTexts()).toEqual(['Open in default app', 'Typora', 'VS Code']);
  expect(submenuEl()!.querySelector('img')?.getAttribute('src')).toBe('typora.png');
  menuItem(submenuEl()!, 'VS Code').click();
  await flush();
  expect(open).toHaveBeenCalledWith('vscode', { path: '/tmp/notes.md' });
  expect(openWithDefaultApp).not.toHaveBeenCalled();
  expect(state.open).toBe(false);
});

it('does not offer open-with for unsupported, deleted, or symlinked files', async () => {
  const openWithDefaultApp = vi.fn<(path: string) => Promise<boolean>>().mockResolvedValue(true);
  mountHost(undefined, openWithDefaultApp, openInServiceStub().service);
  const host = document.createElement('div');
  host.innerHTML =
    '<button data-file-path="/tmp/a.ts">a.ts</button>' +
    '<button data-file-path="/tmp/gone.md" data-file-deleted>gone.md</button>' +
    '<button data-file-path="/tmp/link.md" data-file-symlink>link.md</button>';
  document.body.append(host);
  for (const el of host.querySelectorAll('button')) {
    rightClickOn(el);
    await flush();
    expect(menuTexts().join('|')).not.toContain('Open with');
    expect(menuTexts().join('|')).toContain('Copy path');
  }
  expect(openWithDefaultApp).not.toHaveBeenCalled();
});

it('does not offer open-with without native services', async () => {
  mountHost();
  const host = document.createElement('div');
  host.innerHTML = '<button data-file-path="/tmp/a.md">a.md</button>';
  document.body.append(host);
  rightClickOn(host.querySelector('button')!);
  await flush();
  expect(menuTexts().join('|')).not.toContain('Open with');
  expect(menuTexts().join('|')).toContain('Copy path');
});

it('keeps the submenu open across pointer travel and closes it in stages', async () => {
  mountHost(undefined, vi.fn(async () => true), openInServiceStub().service);
  const host = document.createElement('div');
  host.innerHTML = '<button data-file-path="/tmp/a.md">a.md</button>';
  document.body.append(host);
  rightClickOn(host.querySelector('button')!);
  await flush();
  const parent = menuItem(menuEl()!, 'Open with');
  document.querySelector('.file-context-open-with')!.dispatchEvent(new Event('mouseenter'));
  await flush();
  expect(submenuEl()).not.toBeNull();
  expect(parent.classList.contains('is-active')).toBe(true);
  submenuEl()!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  expect(state.open).toBe(true);
  expect(submenuEl()).not.toBeNull();

  menuItem(menuEl()!, 'Copy path').dispatchEvent(new Event('mouseenter'));
  await flush();
  expect(submenuEl()).toBeNull();
  expect(state.open).toBe(true);

  parent.click();
  await flush();
  expect(submenuEl()).not.toBeNull();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  await flush();
  expect(submenuEl()).toBeNull();
  expect(state.open).toBe(true);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  expect(state.open).toBe(false);
});

it('supports directional keys and focus movement between parent and submenu', async () => {
  mountHost(undefined, vi.fn(async () => true), openInServiceStub().service);
  const host = document.createElement('div');
  host.innerHTML = '<button data-file-path="/tmp/a.md">a.md</button>';
  document.body.append(host);
  rightClickOn(host.querySelector('button')!);
  await flush();
  const parent = menuItem(menuEl()!, 'Open with');
  parent.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await flush();
  expect(submenuEl()).not.toBeNull();
  expect((document.activeElement?.textContent ?? '').trim()).toBe('Open in default app');

  submenuEl()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect((document.activeElement?.textContent ?? '').trim()).toBe('Typora');
  submenuEl()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  await flush();
  expect(submenuEl()).toBeNull();
  expect((document.activeElement?.textContent ?? '').trim()).toBe('Open with');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  expect(state.open).toBe(false);
});

it('places the submenu inside the viewport edges', async () => {
  mountHost(undefined, vi.fn(async () => true), openInServiceStub().service);
  const host = document.createElement('div');
  host.innerHTML = '<button data-file-path="/tmp/a.md">a.md</button>';
  document.body.append(host);
  rightClickOn(host.querySelector('button')!);
  await flush();
  const anchor = document.querySelector<HTMLElement>('.file-context-open-with')!;
  anchor.getBoundingClientRect = () => ({ left: 1100, right: 1120, top: 600, bottom: 630 }) as DOMRect;
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(250);
  window.innerWidth = 1200;
  window.innerHeight = 700;
  menuItem(menuEl()!, 'Open with').click();
  await flush();
  expect(submenuEl()!.style.left).toBe('796px');
  expect(submenuEl()!.style.top).toBe('442px');
});

it('moves focus into the submenu on keyboard activation', async () => {
  mountHost(undefined, vi.fn(async () => true), openInServiceStub().service);
  const host = document.createElement('div');
  host.innerHTML = '<button data-file-path="/tmp/a.md">a.md</button>';
  document.body.append(host);
  rightClickOn(host.querySelector('button')!);
  await flush();
  const parent = menuItem(menuEl()!, 'Open with');
  expect(parent.getAttribute('aria-haspopup')).toBe('menu');
  parent.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
  await flush();
  expect(submenuEl()).not.toBeNull();
  expect(parent.getAttribute('aria-expanded')).toBe('true');
  expect((document.activeElement?.textContent ?? '').trim()).toBe('Open in default app');
});

it('repositions the submenu after the async catalog arrives', async () => {
  let resolveCatalog!: (apps: Array<{ id: string; label: string }>) => void;
  const catalog = vi.fn(() => new Promise<Array<{ id: string; label: string }>>((resolve) => { resolveCatalog = resolve; }));
  const service: OpenInService = { catalog, open: vi.fn(async () => true), icon: () => '' };
  mountHost(undefined, vi.fn(async () => true), service);
  const host = document.createElement('div');
  host.innerHTML = '<button data-file-path="/tmp/a.md">a.md</button>';
  document.body.append(host);
  rightClickOn(host.querySelector('button')!);
  await flush();
  const anchor = document.querySelector<HTMLElement>('.file-context-open-with')!;
  anchor.getBoundingClientRect = () => ({ left: 1100, right: 1120, top: 600, bottom: 630 }) as DOMRect;
  let menuHeight = 30;
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => menuHeight);
  window.innerWidth = 1200;
  window.innerHeight = 700;
  menuItem(menuEl()!, 'Open with').click();
  await flush();
  expect(submenuEl()!.style.top).toBe('596px');

  menuHeight = 250;
  resolveCatalog([{ id: 'vscode', label: 'VS Code' }]);
  await flush();
  expect(submenuEl()!.style.top).toBe('442px');
});
