import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWorkModePill, workModePillLayout, type WorkModePillSpec } from '../../src/runtime/workModePill';

const PLAN: WorkModePillSpec = { mode: 'plan', label: 'Plan', dismissLabel: 'Dismiss' };

describe('workModePillLayout', () => {
  const paragraph = { left: 22, top: 10 };
  const host = { left: 10, top: 4 };
  const scroll = { left: 5, top: 7 };

  it('reserves only the first-line advance on pointer layouts', () => {
    expect(
      workModePillLayout(paragraph, host, scroll, {
        width: 70,
        height: 21,
        marginLeft: -2,
        marginRight: 6,
        marginTop: 0,
        marginBottom: 0,
        lane: 'inline',
      }),
    ).toEqual({
      left: 17,
      top: 13,
      inlineReserve: 74,
      blockReserve: 0,
      box: { left: 20, right: 90, top: 10, bottom: 31 },
    });
  });

  it('reserves a touch lane above text without indenting the first line', () => {
    expect(
      workModePillLayout(paragraph, host, scroll, {
        width: 70,
        height: 21,
        marginLeft: -2,
        marginRight: 0,
        marginTop: 0,
        marginBottom: 12,
        lane: 'block',
      }),
    ).toEqual({
      left: 17,
      top: 13,
      inlineReserve: 0,
      blockReserve: 33,
      box: { left: 20, right: 90, top: 10, bottom: 31 },
    });
  });

  it('never exposes a negative document reserve', () => {
    const metrics = {
      width: 1,
      height: 1,
      marginLeft: -10,
      marginRight: 0,
      marginTop: -10,
      marginBottom: 0,
    };
    expect(workModePillLayout(paragraph, host, scroll, { ...metrics, lane: 'inline' }).inlineReserve).toBe(0);
    expect(workModePillLayout(paragraph, host, scroll, { ...metrics, lane: 'block' }).blockReserve).toBe(0);
  });
});

class FakeEl {
  className = '';
  textContent = '';
  innerHTML = '';
  type = '';
  title = '';
  dataset: Record<string, string> = {};
  readonly children: FakeEl[] = [];
  private readonly attrs = new Map<string, string>();
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(readonly tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  addEventListener(type: string, fn: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  dispatch(type: string, event: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  append(...kids: FakeEl[]): void {
    this.children.push(...kids);
  }
}

describe('buildWorkModePill', () => {
  beforeAll(() => {
    (globalThis as { document?: unknown }).document = {
      createElement: (tag: string) => new FakeEl(tag),
    };
  });

  afterAll(() => {
    delete (globalThis as { document?: unknown }).document;
  });

  it('builds outer chrome with mode glyph, label, and a working dismiss button', () => {
    let dismissed = 0;
    const pill = buildWorkModePill(PLAN, () => dismissed++) as unknown as FakeEl;
    expect(pill.tagName).toBe('SPAN');
    expect(pill.className).toBe('wm-pill');
    expect(pill.dataset.workMode).toBe('plan');
    const [icon, label, dismiss] = pill.children;
    expect(icon!.getAttribute('aria-hidden')).toBe('true');
    expect(icon!.innerHTML).toContain('<svg');
    expect(label!.textContent).toBe('Plan');
    expect(dismiss!.tagName).toBe('BUTTON');
    expect(dismiss!.className).toBe('wm-x');
    expect(dismiss!.getAttribute('aria-label')).toBe('Dismiss');
    expect(dismiss!.innerHTML).toContain('<svg');

    let prevented = false;
    pill.dispatch('mousedown', { preventDefault: () => (prevented = true) });
    expect(prevented).toBe(true);
    dismiss!.dispatch('click', {});
    expect(dismissed).toBe(1);
  });
});
