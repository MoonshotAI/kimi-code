// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import { getIcon, type IconName } from '@moonshot-ai/app-client/icons';
import { dismissToastByKey, onToast, toast } from '@moonshot-ai/app-client/client';
import { warningsStore } from '@moonshot-ai/app-client/stores';
import AppToasts from '../src/AppToasts.vue';

let app: App | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  warningsStore().setWarnings([]);
  app = createApp({ render: () => h(AppToasts) });
  app.use(createKimiI18n({ locale: 'en' }));
  app.provide(IconResolverKey, (name) => getIcon(name as IconName)?.component);
  app.mount(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  warningsStore().setWarnings([]);
  vi.useRealTimers();
});

function texts(): string {
  return host.textContent ?? '';
}

function count(): number {
  return host.querySelectorAll('.ui-toast-bar, .ui-toast').length;
}

describe('AppToasts command items', () => {
  it('replaces a replace-mode toast with the next one in the same position', async () => {
    toast({ layout: 'bar', mode: 'replace', title: 'first' });
    await nextTick();
    expect(texts()).toContain('first');
    toast({ layout: 'bar', mode: 'replace', title: 'second' });
    await vi.waitFor(() => {
      expect(count()).toBe(1);
      expect(texts()).toContain('second');
    });
    expect(texts()).not.toContain('first');
  });

  it('dismisses keyed items removed by a direct replacement toast', async () => {
    const dismissed: number[] = [];
    const off = onToast((event) => {
      if (event.type === 'dismiss' && event.key !== undefined) dismissed.push(event.key);
    });
    toast({ layout: 'bar', mode: 'replace', title: 'first' }, 7);
    await nextTick();
    toast({ layout: 'bar', mode: 'replace', title: 'second' });
    await vi.waitFor(() => expect(dismissed).toEqual([7]));
    off();
  });

  it('stacks stack-mode toasts and dismisses by key', async () => {
    toast({ layout: 'bar', title: 'alpha' });
    toast({ layout: 'bar', title: 'beta' }, 42);
    await nextTick();
    expect(count()).toBe(2);
    dismissToastByKey(42);
    await vi.waitFor(() => expect(count()).toBe(1));
    expect(texts()).toContain('alpha');
    expect(texts()).not.toContain('beta');
  });

  it('emits one dismiss event when a keyed toast closes', async () => {
    const dismissed: number[] = [];
    const off = onToast((event) => {
      if (event.type === 'dismiss' && event.key !== undefined) dismissed.push(event.key);
    });
    toast({ layout: 'bar', title: 'keyed', duration: 20 }, 42);
    await nextTick();
    await vi.waitFor(() => expect(dismissed).toEqual([42]));
    off();
  });

  it('closes a toast automatically after its duration', async () => {
    toast({ layout: 'bar', title: 'ephemeral', duration: 20 });
    await nextTick();
    expect(count()).toBe(1);
    await vi.waitFor(() => expect(count()).toBe(0), { timeout: 2000 });
  });

  it('shows a leading error icon on a danger bar toast and keeps default bars icon-free', async () => {
    toast({ layout: 'bar', mode: 'replace', variant: 'danger', title: 'Authorization failed', duration: 5_000 });
    await nextTick();

    const dangerBar = host.querySelector<HTMLElement>('.ui-toast-bar.ui-toast--danger')!;
    expect(dangerBar).not.toBeNull();
    expect(dangerBar.firstElementChild?.classList.contains('ui-toast__icon')).toBe(true);
    expect(dangerBar.querySelector('.ui-toast__icon svg')).not.toBeNull();
    expect(dangerBar.querySelector('.ui-toast__msg')).toBeNull();

    toast({ layout: 'bar', mode: 'replace', title: 'Deleted' });
    await vi.waitFor(() => {
      expect(host.querySelector('.ui-toast-bar.ui-toast--danger')).toBeNull();
    });
    expect(host.querySelector('.ui-toast-bar .ui-toast__icon')).toBeNull();
  });
});

describe('AppToasts notice items', () => {
  it('keeps the remaining duplicate notice on its own timer', async () => {
    vi.useFakeTimers();
    const warning = { severity: 'info', title: 'duplicate' } as const;
    warningsStore().setWarnings([warning]);
    await nextTick();
    await vi.advanceTimersByTimeAsync(100);
    warningsStore().pushWarning(warning);
    await nextTick();
    expect(count()).toBe(2);

    await vi.advanceTimersByTimeAsync(5900);
    await nextTick();
    expect(warningsStore().warnings).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(99);
    await nextTick();
    expect(warningsStore().warnings).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await nextTick();
    expect(warningsStore().warnings).toEqual([]);
  });

  it('dismisses the duplicate notice at the requested position', async () => {
    warningsStore().setWarnings([
      { severity: 'info', title: 'same', position: 'bottom-right' },
      { severity: 'info', title: 'same', position: 'top-right' },
    ]);
    await nextTick();

    const close = host.querySelector<HTMLButtonElement>('.app-toasts[data-position="bottom-right"] .ui-toast__close');
    expect(close).not.toBeNull();
    close!.click();
    await nextTick();

    expect(warningsStore().warnings.map((warning) => warning.position)).toEqual(['top-right']);
  });
});
