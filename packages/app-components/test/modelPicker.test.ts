// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@moonshot-ai/app-components', () => ({ useDialogFocus: () => {} }));

import type { AppModel } from '@moonshot-ai/app-core/api';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import ModelPicker from '../src/settings/ModelPicker.vue';

let app: App | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

function model(id: string, provider: string): AppModel {
  return { id, provider, model: id, maxContextSize: 100_000 };
}

async function mount(models: AppModel[]): Promise<void> {
  app = createApp({
    render: () => h(ModelPicker, { models, current: models[0]?.id ?? '' }),
  });
  app.use(createKimiI18n({ locale: 'en' }));
  app.mount(host);
  await nextTick();
}

function providerTabs(): string[] {
  return [...document.querySelectorAll<HTMLButtonElement>('.chip')].map(
    (button) => button.textContent?.trim() ?? '',
  );
}

describe('ModelPicker provider tabs', () => {
  it('puts the Kimi subscription first while preserving the remaining provider order', async () => {
    await mount([
      model('openai/gpt-4o', 'openai'),
      model('managed:kimi-code/k3', 'managed:kimi-code'),
      model('anthropic/claude-sonnet', 'anthropic'),
      model('openai/gpt-4o-mini', 'openai'),
    ]);

    expect(providerTabs()).toEqual(['All', 'Kimi Subscription', 'openai', 'anthropic']);
  });

  it('preserves first-appearance order when the subscription is unavailable', async () => {
    await mount([
      model('anthropic/claude-sonnet', 'anthropic'),
      model('openai/gpt-4o', 'openai'),
    ]);

    expect(providerTabs()).toEqual(['All', 'anthropic', 'openai']);
  });
});
