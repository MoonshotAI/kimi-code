// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getFileBlob: vi.fn(),
  getSessionMediaBlob: vi.fn(),
}));

vi.mock('@moonshot-ai/app-client/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getKimiWebApi: () => api,
}));

import AuthMedia from '../src/chat/AuthMedia.vue';

let app: App | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  api.getFileBlob.mockReset();
  api.getSessionMediaBlob.mockReset();
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
});

function mount(media: Array<{ fileId?: string; sessionId?: string; url: string }>): void {
  app = createApp({
    render: () => media.map((item) => h(AuthMedia, {
      kind: 'image',
      url: item.url,
      fileId: item.fileId,
      sessionId: item.sessionId,
    })),
  });
  app.mount(host);
}

async function settle(): Promise<void> {
  for (let round = 0; round < 10; round++) {
    await Promise.resolve();
    await nextTick();
  }
}

it('never falls back to unauthenticated image requests after authorized media loads fail', async () => {
  api.getFileBlob.mockRejectedValue(new Error('media temporarily unavailable'));
  const media = Array.from({ length: 10 }, (_, index) => ({
    fileId: `file-${index}`,
    url: `/api/v1/files/file-${index}`,
  }));

  mount(media);
  await settle();

  expect(api.getFileBlob).toHaveBeenCalledTimes(10);
  const images = Array.from(host.querySelectorAll('img'));
  expect(images).toHaveLength(10);
  expect(images.map((image) => image.getAttribute('src'))).toEqual(Array(10).fill(null));
});

it('continues to load URLs that do not require an authorized blob request', async () => {
  mount([{ url: 'data:image/png;base64,AAAA' }]);
  await settle();

  expect(api.getFileBlob).not.toHaveBeenCalled();
  expect(host.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
});
