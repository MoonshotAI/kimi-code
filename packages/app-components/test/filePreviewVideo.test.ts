// @vitest-environment jsdom
import { createApp, h, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { OpenInServiceKey, OpenWithDefaultAppKey } from '@moonshot-ai/app-client/contracts';
import type { FileData } from '@moonshot-ai/app-core/client/types';
import FilePreview from '../src/FilePreview.vue';

vi.mock('@moonshot-ai/app-markdown', () => ({
  Markdown: { template: '<div />' },
}));

vi.mock('@moonshot-ai/app-client/stores', () => ({ useWarningsStore: () => ({ pushWarning: () => {} }) }));

let app: App | null = null;
let host: HTMLDivElement;

beforeEach(() => {
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

function videoFile(overrides: Partial<FileData> = {}): FileData {
  return {
    path: 'media/clip.mp4',
    content: '',
    encoding: 'base64',
    mime: 'video/mp4',
    isBinary: true,
    size: 1_023_694,
    ...overrides,
  };
}

function mount(file: FileData, mediaUrl?: string): HTMLDivElement {
  app = createApp({ render: () => h(FilePreview, { file, loading: false, mediaUrl }) });
  app.use(createKimiI18n({ locale: 'en' }));
  app.provide(OpenInServiceKey, undefined);
  app.provide(OpenWithDefaultAppKey, undefined);
  app.mount(host);
  return host;
}

describe('video file preview', () => {
  it('plays an mp4 through a video element instead of the binary card', () => {
    const signedUrl = '/api/v1/sessions/s1/fs/media/clip.mp4:download?allow_external_symlinks=true&signature=sig';
    const el = mount(videoFile(), signedUrl);
    const video = el.querySelector('video');
    expect(video).not.toBeNull();
    expect(video!.getAttribute('src')).toBe(signedUrl);
    expect(video!.hasAttribute('controls')).toBe(true);
    expect(el.textContent).not.toContain("Can't preview this file");
  });

  it('reports an unavailable video when no source can be resolved', () => {
    const el = mount(videoFile());
    expect(el.querySelector('video')).toBeNull();
    expect(el.textContent).toContain('Video file');
  });
});