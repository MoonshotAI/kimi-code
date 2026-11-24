/// <reference lib="dom" />

export const SENSITIVE_AUTOCOMPLETE_TOKENS: readonly string[] = ['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc'];

export function browserElementSemantics(sensitiveTokens: readonly string[]) {
  const isSensitive = (element: Element): boolean => {
    const autocomplete = (element.getAttribute('autocomplete') || '').trim().toLowerCase().split(/\s+/);
    if (autocomplete.some(token => sensitiveTokens.includes(token))) return true;
    return element.tagName === 'INPUT' && (element.getAttribute('type') || 'text').trim().toLowerCase() === 'password';
  };
  const textOf = (element: Element) => ((element as HTMLElement).innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
  const roleOf = (element: Element): string => {
    const explicit = element.getAttribute('role');
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'input') {
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') return type;
      if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
      if (type === 'range') return 'slider';
      if (type === 'search') return (element as HTMLInputElement).list ? 'combobox' : 'searchbox';
      if (type === 'number') return 'spinbutton';
      return 'textbox';
    }
    return (element as HTMLElement).isContentEditable ? 'textbox' : 'generic';
  };
  const nameOf = (element: Element): string => {
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const label = labelledBy.split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ').replace(/\s+/g, ' ').trim();
      if (label) return label;
    }
    const direct = element.getAttribute('aria-label') || element.getAttribute('alt') || element.getAttribute('title');
    if (direct) return direct.trim();
    const labels = (element as HTMLInputElement).labels;
    if (labels?.length) {
      const label = Array.from(labels).map(textOf).join(' ').trim();
      if (label) return label;
    }
    return (element.getAttribute('placeholder') || (isSensitive(element) ? '' : textOf(element))).trim();
  };
  return { isSensitive, textOf, roleOf, nameOf };
}
