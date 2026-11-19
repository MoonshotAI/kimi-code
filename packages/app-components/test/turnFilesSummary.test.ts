// @vitest-environment jsdom
import { createApp, h, type App } from 'vue';
import { afterEach, expect, it } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { panelApiKey } from '@moonshot-ai/app-client/panel';
import TurnFilesSummary from '../src/chat/TurnFilesSummary.vue';

let app: App | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = undefined;
  host = undefined;
});

it('renders the filename before its directory without a trailing slash', () => {
  host = document.createElement('div');
  document.body.append(host);
  app = createApp({
    render: () => h(TurnFilesSummary, {
      changes: [
        {
          path: '.tmp/activity-summary-ui-test-v2/a-very-long-directory-name-for-checking-ellipsis/index.html',
          added: 918,
          removed: 609,
        },
        { path: 'README.md', added: 1, removed: 0 },
      ],
      turnId: 'turn-1',
    }),
  });
  app.use(createKimiI18n({ locale: 'en' }));
  app.provide(panelApiKey, undefined);
  app.mount(host);

  const files = host.querySelectorAll('.tf-file');
  expect(files).toHaveLength(2);
  expect(files[0]?.children[0]?.classList.contains('tf-base')).toBe(true);
  expect(files[0]?.children[1]?.classList.contains('tf-dir')).toBe(true);
  expect(files[0]?.querySelector('.tf-base')?.textContent).toBe('index.html');
  expect(files[0]?.querySelector('.tf-dir')?.textContent).toBe(
    '.tmp/activity-summary-ui-test-v2/a-very-long-directory-name-for-checking-ellipsis',
  );
  expect(files[0]?.getAttribute('aria-label')).toBe(
    '.tmp/activity-summary-ui-test-v2/a-very-long-directory-name-for-checking-ellipsis/index.html',
  );
  expect(files[1]?.querySelector('.tf-base')?.textContent).toBe('README.md');
  expect(files[1]?.querySelector('.tf-dir')).toBeNull();
  expect(files[1]?.getAttribute('aria-label')).toBe('README.md');
});
