import { Script, createContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BROWSER_LINK_CLICK_MAX_AGE_MS, browserLinkClickedScript, browserLinkClickTrackingScript } from '../../../src/main/browser/browser-link-click-script';

class HTMLAnchorElement { constructor(readonly href: string) {} }
class HTMLAreaElement { constructor(readonly href: string) {} }
class HTMLSpanElement {}
class SVGAElement {
  readonly href: { baseVal: string };
  constructor(href: string, private readonly xlinkHref: string | null = null, readonly baseURI = 'https://example.com/docs/page.html') { this.href = { baseVal: href }; }
  getAttributeNS(namespace: string, name: string): string | null {
    return namespace === 'http://www.w3.org/1999/xlink' && name === 'href' ? this.xlinkHref : null;
  }
}

interface ClickInit { type?: 'click' | 'auxclick'; target?: object; isTrusted?: boolean; button?: number; shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }

function page() {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const clock = { now: 1_000_000 };
  const context = createContext({
    HTMLAnchorElement, HTMLAreaElement, SVGAElement, URL,
    Date: { now: () => clock.now },
    addEventListener: (type: string, listener: (event: unknown) => void, capture: boolean) => {
      expect(capture).toBe(true);
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
  });
  const run = (code: string): unknown => new Script(code).runInContext(context);
  run(browserLinkClickTrackingScript());
  run(browserLinkClickTrackingScript());
  const link = new HTMLAnchorElement('https://example.com/next');
  return {
    clock,
    link,
    click({ type = 'click', target = link, isTrusted = true, button = 0, shiftKey = false, metaKey = false, ctrlKey = false }: ClickInit = {}) {
      const event = { type, isTrusted, button, shiftKey, metaKey, ctrlKey, altKey: false, composedPath: () => [new HTMLSpanElement(), target, {}] };
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    clicked: (url = link.href) => run(browserLinkClickedScript(url)),
    listenerCount: (type: string) => listeners.get(type)?.length ?? 0,
  };
}

describe('browser link click tracking', () => {
  it('installs one capture listener per click type even when injected twice', () => {
    const tab = page();
    expect(tab.listenerCount('click')).toBe(1);
    expect(tab.listenerCount('auxclick')).toBe(1);
  });

  it.each([
    { name: 'a plain click', init: {} },
    { name: 'a Cmd/Ctrl+Shift click', init: { shiftKey: true, metaKey: true } },
    { name: 'a middle click', init: { type: 'auxclick' as const, button: 1 } },
  ])('reports $name on the link once', ({ init }) => {
    const tab = page();
    tab.click(init);
    expect(tab.clicked()).toBe(true);
    expect(tab.clicked()).toBe(false);
  });

  it('accepts clicks on image map areas', () => {
    const tab = page();
    tab.click({ target: new HTMLAreaElement('https://example.com/next'), shiftKey: true, metaKey: true });
    expect(tab.clicked()).toBe(true);
  });

  it.each([
    { name: 'an href attribute', link: new SVGAElement('../next') },
    { name: 'an xlink:href attribute', link: new SVGAElement('', '/docs/next') },
  ])('resolves SVG links with $name against the document base', ({ link }) => {
    const tab = page();
    tab.click({ target: link, shiftKey: true, metaKey: true });
    expect(tab.clicked(link.href.baseVal ? 'https://example.com/next' : 'https://example.com/docs/next')).toBe(true);
  });

  it('ignores SVG links without an address', () => {
    const tab = page();
    tab.click({ target: new SVGAElement(''), shiftKey: true, metaKey: true });
    expect(tab.clicked('https://example.com/docs/page.html')).toBe(false);
  });

  it.each([
    { name: 'a synthesized click', init: { isTrusted: false, shiftKey: true, metaKey: true } },
    { name: 'a right click', init: { type: 'auxclick' as const, button: 2, shiftKey: true, metaKey: true } },
    { name: 'a click outside any link', init: { target: new HTMLSpanElement(), shiftKey: true, metaKey: true } },
  ])('does not report $name as a link click', ({ init }) => {
    const tab = page();
    tab.click(init);
    expect(tab.clicked()).toBe(false);
  });

  it('does not report a click on a different link', () => {
    const tab = page();
    tab.click({ shiftKey: true, metaKey: true });
    expect(tab.clicked('https://example.com/other')).toBe(false);
  });

  it('forgets a link click once a later click lands outside any link', () => {
    const tab = page();
    tab.click();
    tab.click({ target: new HTMLSpanElement() });
    expect(tab.clicked()).toBe(false);
  });

  it('forgets a link click that is too old', () => {
    const tab = page();
    tab.click({ shiftKey: true, metaKey: true });
    tab.clock.now += BROWSER_LINK_CLICK_MAX_AGE_MS;
    expect(tab.clicked()).toBe(false);
  });
});
