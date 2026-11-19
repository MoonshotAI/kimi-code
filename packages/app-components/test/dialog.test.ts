// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';

import { Dialog } from '@moonshot-ai/app-ui';

describe('Dialog', () => {
  it('forwards Escape to outer handlers when requested', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const outerKeydown = vi.fn();
    document.addEventListener('keydown', outerKeydown);
    const app = createApp({
      render: () => h(Dialog, { open: true, title: 'Settings', closeOnEsc: false, forwardEsc: true }),
    });
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(host);
    try {
      await nextTick();
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      document.querySelector<HTMLElement>('.ui-dialog')!.dispatchEvent(event);

      expect(outerKeydown).toHaveBeenCalledOnce();
      expect(event.defaultPrevented).toBe(false);
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    } finally {
      app.unmount();
      host.remove();
      document.removeEventListener('keydown', outerKeydown);
      document.body.innerHTML = '';
    }
  });
});
