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
  toModel?: string;
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
  it('shows target prompt, compact and continue cards, and a footer cancel button for an old session', async () => {
    const select = mountDialog({ sessionType: 'old', toModel: 'Claude Sonnet 4.5', hint: 'Model hint', warning: 'Model warning' });
    await nextTick();

    expect(document.body.textContent).toContain('Switch to Claude Sonnet 4.5. How should this session continue?');
    expect(document.body.textContent).toContain('Model hint');
    expect(document.body.textContent).toContain('Model warning');
    const cards = [...document.querySelectorAll<HTMLButtonElement>('.model-switch-confirm__option')];
    expect(cards).toHaveLength(2);
    expect(cards[0]?.textContent).toContain('Compact and continue');
    expect(cards[0]?.textContent).toContain('Continue this session with lower cost and better results');
    expect(cards[1]?.textContent).toContain('Continue as-is');
    expect(cards[1]?.textContent).toContain('Quality may degrade | cache miss, higher token usage');

    cards[0]!.click();
    expect(select).toHaveBeenCalledWith('compact');

    select.mockClear();
    cards[1]!.click();
    expect(select).toHaveBeenCalledWith('continue');

    select.mockClear();
    button('Cancel')!.click();
    expect(select).toHaveBeenCalledWith('cancel');
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
