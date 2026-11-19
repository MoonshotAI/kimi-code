// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';
import { RadioCardGroup } from '@moonshot-ai/app-ui';

let app: App | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  app?.unmount();
  app = null;
  host?.remove();
  host = null;
});

const OPTIONS = [
  { value: 'system', label: 'System default', description: 'Like other apps' },
  { value: 'kimi', label: 'Kimi Code default' },
  { value: 'custom', label: 'Custom' },
];

function mount(initial: string) {
  const value = ref(initial);
  const updates: string[] = [];
  host = document.createElement('div');
  document.body.append(host);
  app = createApp({
    render: () =>
      h(
        RadioCardGroup,
        {
          modelValue: value.value,
          options: OPTIONS,
          ariaLabel: 'Font',
          'onUpdate:modelValue': (next: string) => {
            updates.push(next);
            value.value = next;
          },
        },
        { detail: ({ option }: { option: { value: string } }) => h('input', { class: 'detail', 'data-for': option.value }) },
      ),
  });
  app.mount(host);
  const root = host;
  const radios = () => [...root.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  const cards = () => [...root.querySelectorAll<HTMLElement>('.ui-radio-card')];
  return { value, updates, radios, cards, root };
}

function key(el: HTMLElement, name: string): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
}

describe('RadioCardGroup', () => {
  it('renders a labelled radio group with one checked, focusable radio', () => {
    const { radios, root } = mount('kimi');
    expect(root.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('Font');
    expect(radios().map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(radios().map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
    expect(radios()[0]?.textContent).toContain('Like other apps');
  });

  it('makes the first radio focusable when nothing is selected', () => {
    const { radios } = mount('missing');
    expect(radios().map((r) => r.tabIndex)).toEqual([0, -1, -1]);
  });

  it('selects a card by clicking anywhere on it', async () => {
    const { cards, updates, radios } = mount('system');
    cards()[2]?.click();
    await nextTick();
    expect(updates).toEqual(['custom']);
    expect(radios()[2]?.getAttribute('aria-checked')).toBe('true');
  });

  it('does not re-emit for the selected card', () => {
    const { cards, updates } = mount('system');
    cards()[0]?.click();
    expect(updates).toEqual([]);
  });

  it('moves selection and focus with arrow keys, wrapping at the ends', async () => {
    const { radios, updates } = mount('system');
    radios()[0]?.focus();
    key(radios()[0]!, 'ArrowDown');
    await nextTick();
    await nextTick();
    expect(updates).toEqual(['kimi']);
    expect(document.activeElement).toBe(radios()[1]);
    key(radios()[1]!, 'ArrowRight');
    await nextTick();
    key(radios()[2]!, 'ArrowDown');
    await nextTick();
    await nextTick();
    expect(updates).toEqual(['kimi', 'custom', 'system']);
    expect(document.activeElement).toBe(radios()[0]);
    key(radios()[0]!, 'ArrowUp');
    await nextTick();
    await nextTick();
    expect(updates.at(-1)).toBe('custom');
    key(radios()[2]!, 'Home');
    await nextTick();
    expect(updates.at(-1)).toBe('system');
    key(radios()[0]!, 'End');
    await nextTick();
    expect(updates.at(-1)).toBe('custom');
  });

  it('shows the detail slot only inside the selected card, and clicks in it do not reselect', async () => {
    const { root, cards, updates } = mount('custom');
    const details = root.querySelectorAll('.detail');
    expect(details).toHaveLength(1);
    expect(cards()[2]?.contains(details[0]!)).toBe(true);
    (details[0] as HTMLElement).click();
    expect(updates).toEqual([]);
  });
});
