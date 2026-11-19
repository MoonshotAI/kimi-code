// @vitest-environment jsdom
import { createApp, h, nextTick, reactive, type App } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import type { ConversationStatus } from '@moonshot-ai/app-core/client/types';

import StatusPanel from '../src/chat/StatusPanel.vue';

const status: ConversationStatus = {
  model: 'stub',
  modelId: 'stub',
  ctxUsed: 0,
  ctxMax: 0,
  permission: 'manual',
  branch: 'main',
  cwd: '/work',
  isGitRepo: true,
};

let app: App | null = null;

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = '';
});

describe('StatusPanel session id', () => {
  it('shows the full current session id and updates when it changes', async () => {
    const state = reactive({ sessionId: 'session-a' });
    const host = document.createElement('div');
    document.body.append(host);
    app = createApp({
      render: () => h(StatusPanel, {
        status,
        sessionId: state.sessionId,
        thinking: 'off',
        planMode: false,
      }),
    });
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(host);
    await nextTick();

    const label = Array.from(document.querySelectorAll('dt')).find(el => el.textContent === 'Session ID');
    expect(label?.parentElement?.querySelector('dd')?.textContent).toBe('session-a');

    state.sessionId = 'session-b';
    await nextTick();
    expect(label?.parentElement?.querySelector('dd')?.textContent).toBe('session-b');
    expect(document.body.textContent).not.toContain('session-a');
  });
});
