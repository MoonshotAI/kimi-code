// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';

import { useConfirmDialog } from '@moonshot-ai/app-client/composables';
import { Dialog } from '@moonshot-ai/app-ui';
import ConfirmDialogHost from '../src/dialogs/ConfirmDialogHost.vue';

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

describe('ConfirmDialogHost', () => {
  it('reports the checkbox state the user leaves when confirming', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp({ render: () => h(ConfirmDialogHost) });
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(host);
    const { confirmWithCheckbox, settle } = useConfirmDialog();
    try {
      const answer = confirmWithCheckbox({
        title: 'Restart?',
        confirmLabel: 'Restart',
        checkbox: { label: 'Continue these sessions after restart', checked: true },
      });
      await nextTick();
      const input = document.querySelector<HTMLInputElement>('.confirm-dialog__checkbox input[type="checkbox"]')!;
      expect(input.checked).toBe(true);
      expect(document.querySelector('.confirm-dialog__checkbox')?.textContent).toContain(
        'Continue these sessions after restart',
      );

      input.click();
      await nextTick();
      expect(input.checked).toBe(false);
      [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.trim() === 'Restart')!
        .click();

      await expect(answer).resolves.toEqual({ confirmed: true, checked: false });
    } finally {
      settle(false);
      app.unmount();
      host.remove();
      document.body.innerHTML = '';
    }
  });
});
