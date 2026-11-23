// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import ModelSwitchConfirmDialog from '../src/dialogs/ModelSwitchConfirmDialog.vue';

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let app: App | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

function mountDialog(props: {
  sessionType: 'old' | 'new';
  kind?: 'model' | 'effort';
  fromEffort?: string;
  toEffort?: string;
  hint?: string;
  warning?: string;
}) {
  const select = vi.fn();
  app = createApp({
    render: () => h(ModelSwitchConfirmDialog, { open: true, ...props, onSelect: select }),
  });
  app.use(createKimiI18n({ locale: 'en' }));
  app.mount(host);
  return select;
}

function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent?.trim() === label);
}

describe('ModelSwitchConfirmDialog', () => {
  it('shows compact, continue, and cancel choices for an old session', async () => {
    const select = mountDialog({ sessionType: 'old', hint: 'Model hint', warning: 'Model warning' });
    await nextTick();

    expect(document.body.textContent).toContain('Model hint');
    expect(document.body.textContent).toContain('Model warning');
    expect(button('Compact and continueLower cost and better output quality when continuing this session')).toBeDefined();
    button('Continue as-isOutput quality may suffer · cache loss may increase token usage')!.click();
    expect(select).toHaveBeenCalledWith('continue');
  });

  it('uses confirm and cancel footer actions for a new session', async () => {
    const select = mountDialog({ sessionType: 'new', hint: 'New model hint', warning: 'New model warning' });
    await nextTick();

    expect(document.body.textContent).not.toContain('Compact and continue');
    expect(document.body.textContent).toContain('New model warning');
    button('Confirm switch')!.click();
    expect(select).toHaveBeenCalledWith('continue');
  });

  it('uses the effort title and confirm actions', async () => {
    const select = mountDialog({
      sessionType: 'old',
      kind: 'effort',
      fromEffort: 'high',
      toEffort: 'max',
      hint: 'Effort hint',
      warning: 'Effort warning',
    });
    await nextTick();

    expect(document.body.textContent).toContain('Confirm effort switch from high to max?');
    expect(document.body.textContent).toContain('Effort warning');
    expect(document.body.textContent).not.toContain('Compact and continue');
    button('Confirm switch')!.click();
    expect(select).toHaveBeenCalledWith('continue');
  });
});
