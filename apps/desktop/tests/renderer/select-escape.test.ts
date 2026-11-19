// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, h, nextTick } from 'vue';

import Select from '../../../../packages/app-ui/src/components/ui/Select.vue';

let app: ReturnType<typeof createApp> | undefined;
let host: HTMLDivElement | undefined;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  app = createApp({
    render: () => h(Select, {
      modelValue: 'ask',
      options: [
        { value: 'ask', label: 'Ask' },
        { value: 'allow', label: 'Allow' },
        { value: 'block', label: 'Block' },
      ],
    }),
  });
  app.mount(host);
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  host?.remove();
  host = undefined;
});

function trigger(): HTMLButtonElement {
  return host!.querySelector<HTMLButtonElement>('button[role="combobox"]')!;
}

function escapeOnTrigger(): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  trigger().dispatchEvent(event);
  return event;
}

describe('Select Escape handling', () => {
  it('consumes Escape only while the menu is open', async () => {
    trigger().click();
    await nextTick();
    expect(document.body.querySelector('[role="listbox"]')).not.toBeNull();

    const event = escapeOnTrigger();

    expect(event.defaultPrevented).toBe(true);
    await nextTick();
    expect(document.body.querySelector('[role="listbox"]')).toBeNull();
  });

  it('lets Escape reach the parent dialog after an option is selected', async () => {
    trigger().click();
    await nextTick();
    document.body.querySelector<HTMLButtonElement>('button[role="option"]')!.click();
    await nextTick();
    expect(document.body.querySelector('[role="listbox"]')).toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');

    const event = escapeOnTrigger();

    expect(event.defaultPrevented).toBe(false);
  });
});
