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

function binaryFile(path: string): FileData {
  return { path, content: '', encoding: 'base64', mime: 'application/octet-stream', isBinary: true, size: 684_032 };
}

function mount(file: FileData | null, openWithDefaultApp?: (path: string) => Promise<boolean>, extra: { error?: string; displayPath?: string } = {}) {
  app = createApp({ render: () => h(FilePreview, { file, loading: false, ...extra }) });
  app.use(createKimiI18n({ locale: 'en' }));
  app.provide(OpenInServiceKey, undefined);
  if (openWithDefaultApp !== undefined) app.provide(OpenWithDefaultAppKey, openWithDefaultApp);
  app.mount(host);
  return host;
}

describe('binary document preview actions', () => {
  it('opens an Office document with the system default app using the complete path', async () => {
    const path = '/Users/moonshot/Downloads/kimi code desktop/自研代码变更说明-KimiCode-侧边栏和session首页.docx';
    const openWithDefaultApp = vi.fn(async () => true);
    const el = mount(binaryFile(path), openWithDefaultApp);
    const button = [...el.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.includes('Open in default app'));
    expect(button).toBeDefined();
    button!.click();
    await vi.waitFor(() => expect(openWithDefaultApp).toHaveBeenCalledExactlyOnceWith(path));
  });

  it('keeps the default-app action when an Office file is too large to preview', async () => {
    const path = '/work/large report.docx';
    const openWithDefaultApp = vi.fn(async () => true);
    const el = mount(null, openWithDefaultApp, { error: 'File is too large to preview', displayPath: path });
    const button = [...el.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.includes('Open in default app'));
    expect(button).toBeDefined();
    button!.click();
    await vi.waitFor(() => expect(openWithDefaultApp).toHaveBeenCalledExactlyOnceWith(path));
  });

  it.each(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'])('offers the default-app action for .%s documents', (extension) => {
    const el = mount(binaryFile(`/work/report.${extension}`), vi.fn(async () => true));
    expect(el.textContent).toContain('Open in default app');
  });

  it('does not offer the action for other binary files', () => {
    expect(mount(binaryFile('/work/archive.bin'), vi.fn(async () => true)).textContent).not.toContain('Open in default app');
  });

  it('does not offer the action without desktop support', () => {
    expect(mount(binaryFile('/work/report.docx')).textContent).not.toContain('Open in default app');
  });
});
