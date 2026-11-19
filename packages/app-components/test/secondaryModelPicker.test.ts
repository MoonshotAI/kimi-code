// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import SecondaryModelPicker from '../src/settings/SecondaryModelPicker.vue';

type Selection = { model: string | null; effort?: string };

let app: App | null = null;
let host: HTMLDivElement;
let selected: Selection[];

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  selected = [];
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function mount(modelValue = 'a'): void {
  app = createApp({
    render: () =>
      h(SecondaryModelPicker, {
        modelValue,
        effort: '',
        groups: [
          {
            provider: 'acme',
            options: [
              { id: 'a', label: 'Alpha' },
              { id: 'b', label: 'Beta' },
            ],
          },
        ],
        modelInfoById: {},
        onSelect: (value: Selection) => selected.push(value),
      }),
  });
  app.use(createKimiI18n({ locale: 'zh' }));
  app.mount(host);
}

function option(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll<HTMLButtonElement>('.sm-picker__option')].find(
    (element) => element.textContent?.includes(label),
  );
  if (!match) throw new Error(`Missing option ${label}`);
  return match;
}

async function openMenu(): Promise<void> {
  host.querySelector<HTMLButtonElement>('.sm-picker__trigger')!.click();
  await nextTick();
}

async function key(key: string): Promise<void> {
  host
    .querySelector<HTMLButtonElement>('.sm-picker__trigger')!
    .dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  await nextTick();
}

describe('SecondaryModelPicker follow default model', () => {
  it('selects follow default model with the mouse without opening efforts', async () => {
    mount();
    await openMenu();

    option('跟随默认模型').click();
    await nextTick();

    expect(selected).toEqual([{ model: null }]);
    expect(document.querySelector('.sm-picker__flyout')).toBeNull();
    expect(document.querySelector('.sm-picker__menu')).toBeNull();
  });

  it('supports keyboard navigation between efforts and follow default model', async () => {
    mount();
    await openMenu();

    await key('ArrowRight');
    expect(document.querySelector('.sm-picker__flyout')).not.toBeNull();

    await key('ArrowLeft');
    await key('Home');
    expect(option('跟随默认模型').classList.contains('is-kb-active')).toBe(true);

    await key('ArrowRight');
    expect(document.querySelector('.sm-picker__flyout')).toBeNull();

    await key('Enter');
    expect(selected).toEqual([{ model: null }]);
    expect(document.querySelector('.sm-picker__menu')).toBeNull();
  });
});
