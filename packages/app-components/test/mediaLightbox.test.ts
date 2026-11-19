// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ToolMedia } from '@moonshot-ai/app-core/client/types';

const workspaceLocation = vi.hoisted(() => ({ local: { value: true } }));
const preview = vi.hoisted(() => ({
  open: vi.fn(),
  contextMenu: null as null | ((pos: { x: number; y: number }) => void),
}));

vi.mock('@moonshot-ai/app-client/lib', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  openImagePreview: (options: { images: unknown; index: unknown; onImageContextMenu: (pos: { x: number; y: number }) => void }) => {
    preview.open({ images: options.images, index: options.index });
    preview.contextMenu = options.onImageContextMenu;
    return { close: () => {}, currentIndex: () => 0, currentSrc: () => null };
  },
}));
vi.mock('@moonshot-ai/app-client/stores', () => ({
  useWarningsStore: () => ({ push: () => {} }),
  workspacesStore: () => ({ isLocalWorkspace: workspaceLocation.local.value }),
}));

import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { OpenWithDefaultAppKey, RevealInFolderKey } from '@moonshot-ai/app-client/contracts';
import MediaLightbox from '../src/chat/MediaLightbox.vue';

let app: App | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  workspaceLocation.local.value = true;
  preview.open.mockClear();
  preview.contextMenu = null;
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
});

function open(props: { media: ToolMedia; images?: ToolMedia[] }, hostActions = false): void {
  app = createApp({ render: () => h(MediaLightbox, props) });
  app.use(createKimiI18n({ locale: 'en' }));
  if (hostActions) {
    app.provide(RevealInFolderKey, async () => true);
    app.provide(OpenWithDefaultAppKey, async () => true);
  }
  app.mount(host);
}

const shotA: ToolMedia = { kind: 'image', url: 'https://media.example/a.png', fileId: 'file-a', sessionId: 'session' };
const shotB: ToolMedia = { kind: 'image', url: 'https://media.example/b.png', fileId: 'file-b', sessionId: 'session' };

it('shows a picture that is not in the gallery on its own instead of the first gallery image', () => {
  const receipt: ToolMedia = { kind: 'image', url: 'data:image/jpeg;base64,AAAA', mimeType: 'image/jpeg' };
  open({ media: receipt, images: [shotA, shotB] });
  expect(preview.open).toHaveBeenCalledExactlyOnceWith({ images: [receipt], index: 0 });
});

it('keeps gallery navigation for a picture that belongs to the gallery', () => {
  open({ media: { ...shotB }, images: [shotA, shotB] });
  expect(preview.open).toHaveBeenCalledExactlyOnceWith({ images: [shotA, shotB], index: 1 });
});

it.each([
  { location: 'local', local: true, visible: true },
  { location: 'remote', local: false, visible: false },
])('offers host actions on a picture only in a $location project', async ({ local, visible }) => {
  workspaceLocation.local.value = local;
  open({ media: { ...shotA, path: '/srv/app/a.png' } }, true);
  preview.contextMenu!({ x: 40, y: 40 });
  await nextTick();
  const items = document.querySelector('.media-preview-menu')?.textContent ?? '';
  expect(items.includes('Reveal in folder')).toBe(visible);
  expect(items.includes('Open with default app')).toBe(visible);
});

it('keeps the context menu open on scroll and closes it on resize', async () => {
  open({ media: shotA });
  preview.contextMenu!({ x: 40, y: 40 });
  await nextTick();
  expect(document.querySelector('.media-preview-menu')).not.toBeNull();

  window.dispatchEvent(new Event('scroll'));
  await nextTick();
  expect(document.querySelector('.media-preview-menu')).not.toBeNull();

  window.dispatchEvent(new Event('resize'));
  await nextTick();
  expect(document.querySelector('.media-preview-menu')).toBeNull();
});
