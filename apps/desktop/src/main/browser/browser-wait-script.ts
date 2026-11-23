/// <reference lib="dom" />
import type { BrowserWaitCondition, BrowserWaitEvidence } from '../../shared/browser-automation';
import type { browserElementSemantics } from './browser-element-semantics';
import type { collectBrowserText } from './browser-text-script';

export function inspectBrowserCondition(
  condition: Exclude<BrowserWaitCondition, { kind: 'url' }>,
  semantics: ReturnType<typeof browserElementSemantics>,
  collectText: typeof collectBrowserText,
): { matched: boolean; evidence: BrowserWaitEvidence } {
  if (condition.kind === 'text') {
    const snapshot = collectText({ kind: 'document' });
    const texts: string[] = [];
    let lastId = '';
    for (const block of snapshot.blocks) {
      if (lastId === block.id) texts[texts.length - 1] += block.text;
      else texts.push(block.text);
      lastId = block.id;
    }
    const found = texts.find(text => condition.match === 'exact' ? text === condition.text : text.includes(condition.text));
    const matched = condition.state === 'present' ? found !== undefined : found === undefined && !snapshot.scanTruncated;
    return { matched, evidence: { kind: 'text', value: (found ?? texts[0] ?? '').slice(0, 512), count: found === undefined ? 0 : 1, scanTruncated: snapshot.scanTruncated } };
  }
  let count = 0;
  let visible = 0;
  let enabled = 0;
  let scanned = 0;
  let scanTruncated = false;
  let name = '';
  const visit = (root: Document | ShadowRoot) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (++scanned > 10000) { scanTruncated = true; return; }
      const element = node as Element;
      if (semantics.roleOf(element) === condition.locator.role) {
        const candidate = semantics.nameOf(element);
        const wanted = condition.locator.name;
        if (wanted === undefined || (condition.locator.exact !== false ? candidate === wanted : candidate.includes(wanted))) {
          count++;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          const shown = style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' && rect.width > 0 && rect.height > 0 && element.getClientRects().length > 0;
          if (shown) {
            visible++;
            name = candidate;
            if (!element.matches(':disabled') && element.getAttribute('aria-disabled') !== 'true') enabled++;
          }
        }
      }
      if (element.shadowRoot) visit(element.shadowRoot);
      if (scanTruncated) return;
    }
  };
  visit(document);
  const matched = condition.state === 'hidden' ? visible === 0 && !scanTruncated : condition.state === 'enabled' ? enabled > 0 : visible > 0;
  return { matched, evidence: { kind: 'element', value: name.slice(0, 512), count, scanTruncated } };
}
