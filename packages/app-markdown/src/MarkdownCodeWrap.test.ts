// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import Markdown from './Markdown.vue';
import { CODE_WRAP_TOGGLE_CLASS } from './lib/codeWrap';

vi.mock('markstream-vue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('markstream-vue')>()),
  enableKatex: () => {},
  enableMermaid: () => {},
}));
vi.mock('./lib/markdownWorkers', () => ({ ensureMarkdownWorkers: () => {} }));

const sheetTexts = new WeakMap<CSSStyleSheet, string>();

beforeAll(() => {
  if (typeof CSSStyleSheet !== 'undefined' && typeof CSSStyleSheet.prototype.replaceSync !== 'function') {
    CSSStyleSheet.prototype.replaceSync = function (text: string) {
      sheetTexts.set(this, text);
    };
  }
  if (typeof ShadowRoot !== 'undefined' && !('adoptedStyleSheets' in ShadowRoot.prototype)) {
    const adopted = new WeakMap<ShadowRoot, CSSStyleSheet[]>();
    Object.defineProperty(ShadowRoot.prototype, 'adoptedStyleSheets', {
      get(this: ShadowRoot) {
        return adopted.get(this) ?? [];
      },
      set(this: ShadowRoot, sheets: CSSStyleSheet[]) {
        adopted.set(this, sheets);
      },
      configurable: true,
    });
  }
});

function splitTopLevelBlocks(css: string): string[] {
  const blocks: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i]!;
    if (quote !== null) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        blocks.push(css.slice(start, i + 1).trim());
        start = i + 1;
      }
    } else if (ch === ';' && depth === 0) {
      start = i + 1;
    }
  }
  return blocks.filter(Boolean);
}

function extractLayerBody(css: string, layerName: string): string {
  const out: string[] = [];
  for (const block of splitTopLevelBlocks(css)) {
    const match = block.match(new RegExp(`^@layer\\s+${layerName}\\s*\\{([\\s\\S]*)\\}$`));
    if (match) out.push(match[1]!);
  }
  return out.join('\n');
}

function flattenSimpleNesting(css: string): string {
  return css.replace(
    /(\[data-overflow="wrap"\])\s*\{\s*&\s*(\[data-line\]),\s*&\s*(\[data-annotation-content\])\s*\{([^}]*)\}\s*\}/g,
    '$1 $2, $1 $3 {$4}',
  );
}

function insertSupportedRules(doc: Document, css: string): void {
  const style = doc.createElement('style');
  doc.head.append(style);
  const sheet = style.sheet!;
  for (const rule of splitTopLevelBlocks(css)) {
    if (rule.startsWith('@') || rule.includes('&') || rule.includes('::highlight(')) continue;
    try {
      sheet.insertRule(rule, sheet.cssRules.length);
    } catch {
      continue;
    }
  }
}

function computeShadowStyles(
  shadow: ShadowRoot,
  selector: string,
): Array<Pick<CSSStyleDeclaration, 'whiteSpace' | 'overflowWrap' | 'overflowX' | 'minHeight'>> {
  const adoptedCss = (shadow.adoptedStyleSheets ?? []).map((s) => sheetTexts.get(s) ?? '').join('\n');
  const inlineStyles = Array.from(shadow.querySelectorAll('style'))
    .map((s) => s.textContent ?? '')
    .join('\n');
  const fullCss = [
    flattenSimpleNesting(extractLayerBody(adoptedCss, 'base')),
    extractLayerBody(inlineStyles, 'rendered'),
    extractLayerBody(inlineStyles, 'unsafe'),
  ].join('\n');

  const frame = document.createElement('iframe');
  document.body.append(frame);
  try {
    const doc = frame.contentDocument!;
    insertSupportedRules(doc, fullCss);
    for (const child of shadow.children) {
      if (child.tagName.toLowerCase() === 'style' || child.tagName.toLowerCase() === 'svg') continue;
      doc.body.append(doc.importNode(child, true));
    }
    return Array.from(doc.body.querySelectorAll<HTMLElement>(selector)).map((el) => {
      const cs = frame.contentWindow!.getComputedStyle(el);
      return {
        whiteSpace: cs.whiteSpace,
        overflowWrap: cs.overflowWrap,
        overflowX: cs.overflowX,
        minHeight: cs.minHeight,
      };
    });
  } finally {
    frame.remove();
  }
}

let app: App | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ x: 0, y: 0, top: 0, left: 0, right: 600, bottom: 200, width: 600, height: 200, toJSON() { return this; } }) as DOMRect,
  );
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mountMarkdown(text: string): Promise<HTMLElement> {
  app = createApp({ render: () => h(Markdown, { text }) });
  app.use(createKimiI18n({ locale: 'en' }));
  app.mount(host);
  await vi.waitFor(
    async () => {
      await nextTick();
      const container = host.querySelector<HTMLElement>('.code-block-container');
      expect(container).not.toBeNull();
      expect(container?.querySelector(`button.${CODE_WRAP_TOGGLE_CLASS}`)).not.toBeNull();
    },
    { timeout: 10_000 },
  );
  return host.querySelector<HTMLElement>('.code-block-container')!;
}

async function waitForShadowPre(container: HTMLElement): Promise<{ shadow: ShadowRoot; pre: HTMLElement }> {
  let shadow: ShadowRoot | null = null;
  let pre: HTMLElement | null = null;
  await vi.waitFor(
    async () => {
      await nextTick();
      shadow = container.querySelector('diffs-container')?.shadowRoot ?? null;
      pre = shadow?.querySelector<HTMLElement>('pre[data-overflow]') ?? null;
      expect(pre).not.toBeNull();
      expect(pre?.querySelector('[data-line]')).not.toBeNull();
      expect(shadow?.querySelector('style[data-unsafe-css]')).not.toBeNull();
    },
    { timeout: 10_000 },
  );
  return { shadow: shadow!, pre: pre! };
}

describe('Markdown code block word-wrap cascade', () => {
  it('overrides markstream unsafeCSS white-space/overflow-wrap on highlighted blocks and restores scroll mode on unwrap', async () => {
    const longLine = 'var client = CreateHttpClientWithSpecifiedHandlerAndTenSecondOverallRequestTimeout(handler);';
    const container = await mountMarkdown(`\`\`\`csharp\n${longLine}\n\`\`\``);
    const { shadow, pre } = await waitForShadowPre(container);
    const wrapBtn = container.querySelector<HTMLButtonElement>(`button.${CODE_WRAP_TOGGLE_CLASS}`)!;

    expect(pre.getAttribute('data-overflow')).toBe('scroll');
    expect(computeShadowStyles(shadow, '[data-code]')[0]!.overflowX).toBe('auto');
    expect(computeShadowStyles(shadow, '[data-line]')[0]!.whiteSpace).toBe('pre');
    expect(computeShadowStyles(shadow, '[data-line]')[0]!.overflowWrap).toBe('normal');

    wrapBtn.click();
    expect(pre.getAttribute('data-overflow')).toBe('wrap');
    expect(computeShadowStyles(shadow, '[data-code]')[0]!.overflowX).toBe('hidden');
    expect(computeShadowStyles(shadow, '[data-line]')[0]!.whiteSpace).toBe('pre-wrap');
    expect(computeShadowStyles(shadow, '[data-line]')[0]!.overflowWrap).toBe('anywhere');

    wrapBtn.click();
    expect(pre.getAttribute('data-overflow')).toBe('scroll');
    expect(computeShadowStyles(shadow, '[data-code]')[0]!.overflowX).toBe('auto');
    expect(computeShadowStyles(shadow, '[data-line]')[0]!.whiteSpace).toBe('pre');
    expect(computeShadowStyles(shadow, '[data-line]')[0]!.overflowWrap).toBe('normal');
  });

  it('preserves 1lh min-height on empty lines in plain-text blocks when wrapped without line numbers', async () => {
    const container = await mountMarkdown('```\nfirst line\n\nthird line\n```');
    const { shadow, pre } = await waitForShadowPre(container);
    const wrapBtn = container.querySelector<HTMLButtonElement>(`button.${CODE_WRAP_TOGGLE_CLASS}`)!;

    wrapBtn.click();
    expect(pre.getAttribute('data-md-nums')).toBe('off');
    const lineStyles = computeShadowStyles(shadow, '[data-line]');
    expect(lineStyles).toHaveLength(3);
    expect(lineStyles[1]!.whiteSpace).toBe('pre-wrap');
    expect(lineStyles[1]!.minHeight).toBe('1lh');
  });

  it('wraps conflict-marker code blocks when word wrap is enabled', async () => {
    const conflict = [
      '<<<<<<< HEAD',
      'const value = "very-long-current-branch-value-that-needs-wrapping-in-narrow-containers";',
      '=======',
      'const value = "very-long-incoming-branch-value-that-needs-wrapping-in-narrow-containers";',
      '>>>>>>> feature',
    ].join('\n');
    const container = await mountMarkdown(`\`\`\`ts\n${conflict}\n\`\`\``);
    const { shadow } = await waitForShadowPre(container);
    const wrapBtn = container.querySelector<HTMLButtonElement>(`button.${CODE_WRAP_TOGGLE_CLASS}`)!;

    wrapBtn.click();
    expect(computeShadowStyles(shadow, '[data-code]')[0]!.overflowX).toBe('hidden');
    expect(computeShadowStyles(shadow, '[data-line]')[0]!.whiteSpace).toBe('pre-wrap');
    expect(computeShadowStyles(shadow, '[data-line]')[0]!.overflowWrap).toBe('anywhere');
  });
});
