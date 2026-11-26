// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import Dialog from '../src/components/ui/Dialog.vue';

let app: App | null = null;
let host: HTMLDivElement;

afterEach(() => {
  app?.unmount();
  app = null;
  host?.remove();
  document.body.innerHTML = '';
});

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await nextTick();
}

async function mountDialog(
  props: Record<string, unknown> = {},
  slots: Record<string, () => unknown> = {},
): Promise<void> {
  host = document.createElement('div');
  document.body.append(host);
  app = createApp({
    render: () => h(Dialog, { open: true, title: 'Test', ...props }, slots),
  });
  app.use(createKimiI18n({ locale: 'en' }));
  app.mount(host);
  await flush();
}

function closeButton(): HTMLElement {
  return document.querySelector<HTMLElement>('.ui-dialog__close')!;
}

function panel(): HTMLElement {
  return document.querySelector<HTMLElement>('.ui-dialog')!;
}

describe('Dialog default focus', () => {
  it('skips the title-bar close button and focuses the first body or footer control', async () => {
    await mountDialog({}, {
      default: () => h('button', { class: 'body-action' }, 'Continue'),
      foot: () => h('button', { class: 'foot-action' }, 'OK'),
    });
    expect(document.activeElement).not.toBe(closeButton());
    expect(document.activeElement).toBe(document.querySelector('.body-action'));
  });

  it('focuses the footer control when the body has no interactive elements', async () => {
    await mountDialog({}, {
      default: () => h('p', 'Read this first'),
      foot: () => h('button', { class: 'foot-action' }, 'OK'),
    });
    expect(document.activeElement).toBe(document.querySelector('.foot-action'));
    expect(document.activeElement).not.toBe(closeButton());
  });

  it('focuses the panel when there is no body or footer control', async () => {
    await mountDialog({}, {
      default: () => h('p', 'Nothing to click'),
    });
    expect(document.activeElement).not.toBe(closeButton());
    expect(document.activeElement).toBe(panel());
  });

  it('honors an explicit initial-focus target', async () => {
    await mountDialog({ initialFocus: '.foot-action' }, {
      default: () => h('button', { class: 'body-action' }, 'Continue'),
      foot: () => h('button', { class: 'foot-action' }, 'OK'),
    });
    expect(document.activeElement).toBe(document.querySelector('.foot-action'));
  });

  it('keeps the close button in the tab cycle', async () => {
    await mountDialog({}, {
      foot: () => h('button', { class: 'foot-action' }, 'OK'),
    });
    expect(document.activeElement).toBe(document.querySelector('.foot-action'));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(closeButton());
  });
});
