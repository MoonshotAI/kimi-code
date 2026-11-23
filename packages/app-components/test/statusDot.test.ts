// @vitest-environment jsdom
import { createApp, h, type App } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';
import { StatusDot } from '@moonshot-ai/app-ui';

let app: App | undefined;
let host: HTMLDivElement | undefined;

function mountDot(props: Record<string, unknown>, attrs: Record<string, unknown> = {}): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  app = createApp({ setup: () => () => h(StatusDot, { ...props, ...attrs }) });
  app.mount(host);
  return host.querySelector('.kw-dot')!;
}

afterEach(() => {
  app?.unmount();
  app = undefined;
  host?.remove();
  host = undefined;
});

describe('StatusDot', () => {
  it.each([
    ['unread', 'kw-dot--unread'],
    ['archived', 'kw-dot--archived'],
    ['done', 'kw-dot--ok'],
    ['running', 'kw-dot--running'],
    [undefined, 'kw-dot--idle'],
  ])('maps status %s to %s', (status, cls) => {
    const el = mountDot({ status });
    expect(el.classList.contains(cls)).toBe(true);
  });

  it('defaults to md with no ring', () => {
    const el = mountDot({ status: 'ok' });
    expect(el.classList.contains('kw-dot--md')).toBe(true);
    expect([...el.classList].some((c) => c.startsWith('kw-dot--ring-'))).toBe(false);
  });

  it.each(['sm', 'md', 'lg'])('applies size %s', (size) => {
    const el = mountDot({ status: 'ok', size });
    expect(el.classList.contains(`kw-dot--${size}`)).toBe(true);
  });

  it.each(['halo', 'surface'])('applies ring %s', (ring) => {
    const el = mountDot({ status: 'unread', ring });
    expect(el.classList.contains(`kw-dot--ring-${ring}`)).toBe(true);
  });

  it('passes attributes through to the root', () => {
    const el = mountDot({ status: 'unread' }, { 'data-testid': 'session-unread' });
    expect(el.getAttribute('data-testid')).toBe('session-unread');
    expect(el.getAttribute('aria-hidden')).toBe('true');
  });
});
