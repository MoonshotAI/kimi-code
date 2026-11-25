// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import { OpenSessionLinkKey, type OpenSessionLink, type ResolveOpenSessionLink } from '@moonshot-ai/app-core/contracts';
import ComposerText from '../../src/transcript/ComposerText.vue';

const TEXT = 'compare with [Fix login](kimi-code://sessions/session_1)';

let app: App | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = null;
  host = null;
});

async function renderPill(options: { resolveOpenSessionLink?: ResolveOpenSessionLink; interactive?: boolean } = {}): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.append(host);
  app = createApp({ render: () => h(ComposerText, { text: TEXT, interactive: options.interactive ?? true }) });
  if (options.resolveOpenSessionLink !== undefined) app.provide(OpenSessionLinkKey, options.resolveOpenSessionLink);
  app.mount(host);
  await nextTick();
  const pill = host.querySelector<HTMLElement>('.mention-session');
  expect(pill).not.toBeNull();
  return pill!;
}

it('opens the referenced session when its pill is clicked or activated from the keyboard', async () => {
  const openSessionLink = vi.fn<OpenSessionLink>();
  const pill = await renderPill({ resolveOpenSessionLink: () => openSessionLink });
  expect(pill.getAttribute('role')).toBe('button');
  expect(pill.getAttribute('tabindex')).toBe('0');

  pill.click();
  pill.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  expect(openSessionLink.mock.calls).toEqual([['session_1'], ['session_1']]);
});

it('keeps the session pill inert when nothing can open sessions', async () => {
  const pill = await renderPill();
  expect(pill.getAttribute('role')).toBeNull();
  expect(pill.getAttribute('tabindex')).toBeNull();
});

it('follows the host switching session opening on and off', async () => {
  const enabled = ref(false);
  const openSessionLink = vi.fn<OpenSessionLink>();
  const pill = await renderPill({ resolveOpenSessionLink: () => (enabled.value ? openSessionLink : undefined) });
  pill.click();
  expect(pill.getAttribute('role')).toBeNull();
  expect(openSessionLink).not.toHaveBeenCalled();

  enabled.value = true;
  await nextTick();
  const live = host!.querySelector<HTMLElement>('.mention-session')!;
  expect(live.getAttribute('role')).toBe('button');
  live.click();
  expect(openSessionLink).toHaveBeenCalledExactlyOnceWith('session_1');
});

it('keeps the session pill inert in non-interactive text', async () => {
  const openSessionLink = vi.fn<OpenSessionLink>();
  const pill = await renderPill({ resolveOpenSessionLink: () => openSessionLink, interactive: false });
  pill.click();
  expect(pill.getAttribute('role')).toBeNull();
  expect(openSessionLink).not.toHaveBeenCalled();
});
