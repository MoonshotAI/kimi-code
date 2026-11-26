// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp, h, nextTick, ref, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import type { AppConfig } from '@moonshot-ai/app-core/api';
import SecondaryModelSettings from '../src/settings/SecondaryModelSettings.vue';

let app: App | null = null;
let host: HTMLDivElement;
let updates: Array<AppConfig['secondaryModel']>;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  updates = [];
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function mount(initialConfig?: AppConfig['secondaryModel']) {
  const config = ref<AppConfig['secondaryModel']>(initialConfig);
  app = createApp({
    render: () =>
      h(SecondaryModelSettings, {
        config: config.value,
        defaultModel: 'kimi/k3',
        groups: [
          {
            provider: 'managed:kimi-code',
            options: [
              { id: 'kimi/highspeed', label: 'Kimi Highspeed' },
              { id: 'kimi/k3', label: 'Kimi K3' },
            ],
          },
        ],
        modelInfoById: {
          'kimi/highspeed': {
            capabilities: ['thinking'],
            supportEfforts: ['low', 'high'],
          },
          'kimi/k3': {
            capabilities: ['thinking', 'always_thinking'],
            supportEfforts: ['low', 'high', 'max'],
          },
        },
        onUpdate: (value: AppConfig['secondaryModel']) => {
          updates.push(value);
          config.value = value;
        },
      }),
  });
  app.use(createKimiI18n({ locale: 'zh' }));
  app.mount(host);
  return { config };
}

function buttonWithText(label: string): HTMLButtonElement {
  const match = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Missing button ${label}`);
  return match;
}

describe('SecondaryModelSettings', () => {
  it('defaults to follow mode and switches cleanly to fixed and auto modes', async () => {
    mount(undefined);
    expect(host.textContent).toContain('沿用当前会话的主模型与思考强度');

    buttonWithText('固定模型').click();
    await nextTick();
    expect(updates.at(-1)).toEqual({ defaultModel: 'kimi/k3' });
    expect(host.textContent).toContain('所有子智能体固定使用该模型，主智能体不可切换');

    buttonWithText('自动选择').click();
    await nextTick();
    expect(updates.at(-1)).toMatchObject({
      allModels: true,
      rule: expect.stringContaining('轻量模型'),
    });

    buttonWithText('速度优先').click();
    await nextTick();
    expect(updates.at(-1)).toMatchObject({
      allModels: true,
      rule: expect.stringContaining('高速模型'),
    });
  });

  it('supports selected models pool with per-model effort and description', async () => {
    mount({
      defaultModel: 'kimi/highspeed',
      rule: '自定义规则',
      models: {
        'kimi/highspeed': { description: '快速检索', effort: 'low' },
        'kimi/k3': '复杂推理',
      },
    });
    await nextTick();

    expect(host.textContent).toContain('仅从已勾选的 2 个模型中分配');
    const checkboxes = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(checkboxes.map((el) => el.checked)).toEqual([true, true]);

    const descInput = host.querySelector<HTMLInputElement>('input[aria-label="Kimi K3"]')!;
    expect(descInput.value).toBe('复杂推理');
    descInput.value = '深度调试';
    descInput.dispatchEvent(new Event('input', { bubbles: true }));
    descInput.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    await nextTick();

    expect(updates.at(-1)).toEqual({
      defaultModel: 'kimi/highspeed',
      rule: '自定义规则',
      models: {
        'kimi/highspeed': { description: '快速检索', effort: 'low' },
        'kimi/k3': '深度调试',
      },
    });
  });

  it('preserves pool draft in memory when switching temporarily to follow and back', async () => {
    mount({
      defaultModel: 'kimi/highspeed',
      rule: '我的规则',
      models: {
        'kimi/highspeed': { description: '检索', effort: 'low' },
      },
    });
    await nextTick();

    buttonWithText('跟随主模型').click();
    await nextTick();
    expect(updates.at(-1)).toBeNull();

    buttonWithText('自动选择').click();
    await nextTick();
    expect(updates.at(-1)).toEqual({
      defaultModel: 'kimi/highspeed',
      rule: '我的规则',
      models: {
        'kimi/highspeed': { description: '检索', effort: 'low' },
      },
    });
  });

  it('focuses the rule textarea when switching to custom rule preset', async () => {
    mount({ allModels: true });
    await nextTick();

    buttonWithText('自定义').click();
    await nextTick();
    const textarea = host.querySelector('textarea');
    expect(document.activeElement).toBe(textarea);
  });

  it('scopes settings-common.css instead of importing it globally in script', () => {
    const source = readFileSync(
      resolve(__dirname, '../src/settings/SecondaryModelSettings.vue'),
      'utf8',
    );
    expect(source).not.toMatch(/import\s+['"]\.\/settings-common\.css['"]/);
    expect(source).toContain('<style scoped src="./settings-common.css"></style>');
  });
});
