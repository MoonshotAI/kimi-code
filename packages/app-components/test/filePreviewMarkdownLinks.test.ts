// @vitest-environment jsdom
import { createApp, h, type App } from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { OpenInServiceKey } from '@moonshot-ai/app-client/contracts';
import type { FileData } from '@moonshot-ai/app-core/client/types';
import FilePreview from '../src/FilePreview.vue';

vi.mock('@moonshot-ai/app-markdown', () => ({
  Markdown: {
    props: ['openFile'],
    template: '<button class="nested-link" @click="openFile({ path: \'~/rules.md\' })">rules</button>',
  },
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

function mount(path: string, openFile: (target: { path: string }) => void): HTMLElement {
  const file: FileData = { path, content: '[rules](~/rules.md)', encoding: 'utf-8', mime: 'text/markdown', isBinary: false, size: 18 };
  app = createApp({ render: () => h(FilePreview, { file, loading: false, openFile }) });
  app.use(createKimiI18n({ locale: 'en' }));
  app.provide(OpenInServiceKey, undefined);
  app.mount(host);
  return host;
}

it('passes a tilde link through without joining it to the preview directory', async () => {
  const openFile = vi.fn();
  const el = mount('/Users/test/docs/readme.md', openFile);

  el.querySelector<HTMLButtonElement>('.nested-link')!.click();

  await vi.waitFor(() => expect(openFile).toHaveBeenCalledExactlyOnceWith({ path: '~/rules.md' }));
});
