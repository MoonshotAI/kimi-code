// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey, NumberInput } from '@moonshot-ai/app-ui';
import { getIcon, type IconName } from '@moonshot-ai/app-ui/icons';

let app: App | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  app?.unmount();
  app = null;
  host?.remove();
  host = null;
});

function mount(
  initial: number | null,
  opts: { min?: number; max?: number; step?: number; placeholder?: number } = {},
  realIcons = false,
) {
  const value = ref<number | null>(initial);
  const updates: (number | null)[] = [];
  host = document.createElement('div');
  document.body.append(host);
  app = createApp({
    render: () =>
      h(NumberInput, {
        modelValue: value.value,
        min: opts.min ?? 9,
        max: opts.max ?? 32,
        step: opts.step,
        placeholder: opts.placeholder,
        ariaLabel: 'Size',
        'onUpdate:modelValue': (next: number | null) => {
          updates.push(next);
          value.value = next;
        },
      }),
  });
  app.provide(IconResolverKey, realIcons
    ? (name) => getIcon(name as IconName)?.component
    : (name) => ({ render: () => h('svg', { 'data-icon': name }) }));
  app.use(createKimiI18n({ locale: 'en' }));
  app.mount(host);
  const [dec, inc] = [...host.querySelectorAll<HTMLButtonElement>('.ui-number-input__step')];
  const input = host.querySelector<HTMLInputElement>('input')!;
  return { value, updates, dec: dec!, inc: inc!, input };
}

async function type(input: HTMLInputElement, text: string) {
  input.value = text;
  input.dispatchEvent(new Event('input'));
  await nextTick();
}

describe('NumberInput', () => {
  it('renders a text field with labelled step buttons', () => {
    const { dec, inc, input } = mount(13);
    expect(input.type).toBe('text');
    expect(input.value).toBe('13');
    expect(input.getAttribute('aria-label')).toBe('Size');
    expect(dec.getAttribute('aria-label')).toBe('Decrease');
    expect(inc.getAttribute('aria-label')).toBe('Increase');
  });

  it('draws a registered minus and plus glyph in the step buttons', () => {
    const { dec, inc } = mount(13, {}, true);
    expect(dec.getAttribute('aria-label')).toBe('Decrease');
    expect(inc.getAttribute('aria-label')).toBe('Increase');
    expect(dec.querySelector('svg')).not.toBeNull();
    expect(inc.querySelector('svg')).not.toBeNull();
    expect(getIcon('minus')).toBeDefined();
    expect(getIcon('plus')).toBeDefined();
  });

  it('steps with the buttons and disables at the bounds', async () => {
    const { value, dec, inc, input } = mount(31);
    inc.click();
    await nextTick();
    expect(value.value).toBe(32);
    expect(input.value).toBe('32');
    expect(inc.disabled).toBe(true);
    expect(dec.disabled).toBe(false);
    dec.click();
    await nextTick();
    expect(value.value).toBe(31);
    expect(inc.disabled).toBe(false);
  });

  it('honours the step and clamps when stepping past a bound', async () => {
    const { value, inc } = mount(30, { step: 5 });
    inc.click();
    await nextTick();
    expect(value.value).toBe(32);
  });

  it('steps from the placeholder when empty', async () => {
    const { value, inc, input } = mount(null, { placeholder: 13 });
    expect(input.value).toBe('');
    inc.click();
    await nextTick();
    expect(value.value).toBe(14);
  });

  it('commits typed values on blur, clamped', async () => {
    const { value, updates, input } = mount(13);
    await type(input, '40');
    expect(updates).toEqual([]);
    input.dispatchEvent(new Event('blur'));
    await nextTick();
    expect(value.value).toBe(32);
    expect(input.value).toBe('32');
  });

  it('commits on Enter and reverts invalid input', async () => {
    const { value, updates, input } = mount(13);
    await type(input, '5');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await nextTick();
    expect(value.value).toBe(9);
    await type(input, 'abc');
    input.dispatchEvent(new Event('blur'));
    await nextTick();
    expect(value.value).toBe(9);
    expect(input.value).toBe('9');
    expect(updates).toEqual([9]);
  });

  it('clears to null when emptied', async () => {
    const { value, input } = mount(13, { placeholder: 13 });
    await type(input, '');
    input.dispatchEvent(new Event('blur'));
    await nextTick();
    expect(value.value).toBeNull();
  });

  it('steps with ArrowUp and ArrowDown', async () => {
    const { value, input } = mount(13);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    await nextTick();
    expect(value.value).toBe(14);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    await nextTick();
    expect(value.value).toBe(12);
  });
});
