import { createApp, h, nextTick, type App, type Component, type InjectionKey, type Plugin } from 'vue';
import { createKimiI18n, type KimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';

export type TextMatcher = string | RegExp | ((text: string) => boolean);

export interface RoleOptions {
  name?: TextMatcher;
}

const NAME_FROM_CONTENT = new Set([
  'button',
  'cell',
  'checkbox',
  'columnheader',
  'heading',
  'link',
  'listitem',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'row',
  'switch',
  'tab',
  'tooltip',
  'status',
]);

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function matches(text: string, matcher: TextMatcher): boolean {
  if (typeof matcher === 'string') return text === normalize(matcher);
  if (matcher instanceof RegExp) return matcher.test(text);
  return matcher(text);
}

export function containing(fragment: string): (text: string) => boolean {
  return (text) => text.includes(normalize(fragment));
}

export function isHidden(el: Element): boolean {
  for (let node: Element | null = el; node !== null; node = node.parentElement) {
    if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true') return true;
    if (node instanceof HTMLElement && node.style.display === 'none') return true;
  }
  return false;
}

export function roleOf(el: Element): string | null {
  const explicit = el.getAttribute('role');
  if (explicit !== null && explicit.trim() !== '') return explicit.trim().split(/\s+/)[0]!;
  switch (el.tagName.toLowerCase()) {
    case 'button':
      return 'button';
    case 'a':
      return el.hasAttribute('href') ? 'link' : null;
    case 'input': {
      const type = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
      return 'textbox';
    }
    case 'textarea':
      return 'textbox';
    case 'ul':
    case 'ol':
      return 'list';
    case 'li':
      return 'listitem';
    case 'dialog':
      return 'dialog';
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return 'heading';
    default:
      return null;
  }
}

function contentText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (!(node instanceof Element) || isHiddenSelf(node)) return '';
  const label = node.getAttribute('aria-label');
  if (label !== null && label.trim() !== '') return ` ${label} `;
  return [...node.childNodes].map((child) => ` ${contentText(child)} `).join('');
}

function isHiddenSelf(el: Element): boolean {
  return (
    el.hasAttribute('hidden') ||
    el.getAttribute('aria-hidden') === 'true' ||
    (el instanceof HTMLElement && el.style.display === 'none')
  );
}

export function textOf(el: Element | null | undefined): string {
  if (el === null || el === undefined) return '';
  return normalize([...el.childNodes].map((child) => ` ${contentText(child)} `).join(''));
}

export function accessibleName(el: Element): string {
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy !== null) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id))
      .filter((node): node is HTMLElement => node !== null)
      .map((node) => textOf(node));
    if (parts.length > 0) return normalize(parts.join(' '));
  }
  const label = el.getAttribute('aria-label');
  if (label !== null && label.trim() !== '') return normalize(label);
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const labels = [...(el.labels ?? [])]
      .map((node) => normalize(node.getAttribute('aria-label') ?? '') || textOf(node))
      .filter((text) => text !== '');
    if (labels.length > 0) return normalize(labels.join(' '));
    return normalize(el.getAttribute('placeholder') ?? el.getAttribute('title') ?? '');
  }
  const role = roleOf(el);
  if (role !== null && NAME_FROM_CONTENT.has(role)) return textOf(el);
  return normalize(el.getAttribute('title') ?? '');
}

function listRoles(container: ParentNode): string {
  const found = [...container.querySelectorAll('*')]
    .filter((el) => !isHidden(el) && roleOf(el) !== null)
    .map((el) => `  ${roleOf(el)} "${accessibleName(el)}"`);
  return found.length === 0 ? '  (no roles)' : found.join('\n');
}

export function queryAllByRole(container: ParentNode, role: string, options: RoleOptions = {}): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('*')].filter(
    (el) =>
      roleOf(el) === role &&
      !isHidden(el) &&
      (options.name === undefined || matches(accessibleName(el), options.name)),
  );
}

function label(role: string, options: RoleOptions): string {
  return options.name === undefined ? role : `${role} named ${String(options.name)}`;
}

export function queryByRole(container: ParentNode, role: string, options: RoleOptions = {}): HTMLElement | null {
  const found = queryAllByRole(container, role, options);
  if (found.length > 1) throw new Error(`Found ${found.length} elements with role ${label(role, options)}`);
  return found[0] ?? null;
}

export function getAllByRole(container: ParentNode, role: string, options: RoleOptions = {}): HTMLElement[] {
  const found = queryAllByRole(container, role, options);
  if (found.length === 0) throw new Error(`No element with role ${label(role, options)}. Available:\n${listRoles(container)}`);
  return found;
}

export function getByRole(container: ParentNode, role: string, options: RoleOptions = {}): HTMLElement {
  const found = getAllByRole(container, role, options);
  if (found.length > 1) throw new Error(`Found ${found.length} elements with role ${label(role, options)}`);
  return found[0]!;
}

export function queryAllByText(container: ParentNode, matcher: TextMatcher): HTMLElement[] {
  const all = [...container.querySelectorAll<HTMLElement>('*')].filter(
    (el) => !isHidden(el) && matches(textOf(el), matcher),
  );
  return all.filter((el) => !all.some((other) => other !== el && el.contains(other)));
}

export function queryByText(container: ParentNode, matcher: TextMatcher): HTMLElement | null {
  const found = queryAllByText(container, matcher);
  if (found.length > 1) throw new Error(`Found ${found.length} elements with text ${String(matcher)}`);
  return found[0] ?? null;
}

export function getByText(container: ParentNode, matcher: TextMatcher): HTMLElement {
  const found = queryByText(container, matcher);
  if (found === null) throw new Error(`No element with text ${String(matcher)}`);
  return found;
}

export function queryAllByLabel(container: ParentNode, matcher: TextMatcher): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[aria-label]')].filter((el) =>
    matches(normalize(el.getAttribute('aria-label') ?? ''), matcher),
  );
}

export function getByLabel(container: ParentNode, matcher: TextMatcher): HTMLElement {
  const found = queryAllByLabel(container, matcher);
  if (found.length !== 1) throw new Error(`Found ${found.length} elements labelled ${String(matcher)}`);
  return found[0]!;
}

export function within(target: ParentNode | (() => ParentNode)) {
  const container =
    typeof target === 'function'
      ? ({ querySelectorAll: (selector: string) => target().querySelectorAll(selector) } as unknown as ParentNode)
      : target;
  return {
    getByRole: (role: string, options?: RoleOptions) => getByRole(container, role, options),
    getAllByRole: (role: string, options?: RoleOptions) => getAllByRole(container, role, options),
    queryByRole: (role: string, options?: RoleOptions) => queryByRole(container, role, options),
    queryAllByRole: (role: string, options?: RoleOptions) => queryAllByRole(container, role, options),
    getByText: (matcher: TextMatcher) => getByText(container, matcher),
    queryByText: (matcher: TextMatcher) => queryByText(container, matcher),
    getByLabel: (matcher: TextMatcher) => getByLabel(container, matcher),
    queryAllByLabel: (matcher: TextMatcher) => queryAllByLabel(container, matcher),
  };
}

export const screen = within(() => document.body);

export function press(target: EventTarget, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

export function typeInto(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

export function pointerDown(target: EventTarget): void {
  target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
}

export async function settle(rounds = 4): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

export function translator(locale: 'en' | 'zh' = 'en') {
  const i18n = createKimiI18n({ locale });
  return (key: string, params?: Record<string, unknown>, plural?: number): string => {
    if (plural !== undefined) return i18n.global.t(key, params ?? {}, plural);
    return params === undefined ? i18n.global.t(key) : i18n.global.t(key, params);
  };
}

export const msg = translator('en');

export const iconStub = (name: string) => ({ render: () => h('svg', { 'data-icon': name }) });

export interface RenderOptions {
  locale?: 'en' | 'zh';
  i18n?: KimiI18n;
  plugins?: Plugin[];
  provide?: Array<[InjectionKey<unknown> | string, unknown]>;
}

export interface Rendered {
  app: App;
  host: HTMLElement;
  unmount: () => void;
}

const mounted = new Set<Rendered>();

export function render(
  component: Component,
  props: Record<string, unknown> | (() => Record<string, unknown>) = {},
  options: RenderOptions = {},
): Rendered {
  const host = document.createElement('div');
  document.body.append(host);
  const read = typeof props === 'function' ? props : () => props;
  const app = createApp({ render: () => h(component, read()) });
  app.use(options.i18n ?? createKimiI18n({ locale: options.locale ?? 'en' }));
  for (const plugin of options.plugins ?? []) app.use(plugin);
  app.provide(IconResolverKey, iconStub);
  for (const [key, value] of options.provide ?? []) app.provide(key, value);
  app.mount(host);
  const rendered: Rendered = {
    app,
    host,
    unmount: () => {
      if (!mounted.delete(rendered)) return;
      app.unmount();
      host.remove();
    },
  };
  mounted.add(rendered);
  return rendered;
}

export function cleanup(): void {
  for (const rendered of mounted) rendered.unmount();
}
