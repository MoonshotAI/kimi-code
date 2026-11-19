// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startMentionTooltip } from '../../src/transcript/mentionTooltip';

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let stop: (() => void) | null = null;
const openPastedText = vi.fn<(text: string) => void>();

function pastedPill(text: string, parent: HTMLElement = document.body): HTMLElement {
  const pill = document.createElement('span');
  pill.className = 'quote-pill pasted-text-pill';
  pill.tabIndex = 0;
  pill.dataset.pastedText = text;
  parent.append(pill);
  return pill;
}

function bubble(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.mention-tip.positioned');
}

function actionLabels(): string[] {
  return [...(bubble()?.querySelectorAll('.mention-tip-media-open') ?? [])].map((button) => button.textContent ?? '');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  openPastedText.mockReset();
  stop = startMentionTooltip({
    pastedTextStats: (lines, chars) => `${lines} lines · ${chars} chars`,
    viewPastedTextLabel: () => 'View text',
    openPastedText,
  });
});

afterEach(() => {
  stop?.();
  stop = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('pasted-text tooltip', () => {
  it('shows a summary instead of the full text and pins on click', () => {
    const body = `first line\n${'x'.repeat(50_000)}`;
    const pill = pastedPill(body);
    pill.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(bubble()?.querySelector('.mention-tip-name')?.textContent).toBe('first line');
    expect(bubble()?.querySelector('.mention-tip-pasted-text-meta')?.textContent).toBe('2 lines · 50011 chars');
    expect(bubble()?.textContent?.length).toBeLessThan(200);
    pill.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    vi.advanceTimersByTime(5_000);
    expect(bubble()).not.toBeNull();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(bubble()).toBeNull();
  });

  it('offers only View text outside the composer and opens the dialog with the full text', () => {
    const pill = pastedPill('body text');
    pill.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(actionLabels()).toEqual(['View text']);
    expect(bubble()?.classList.contains('mention-tip--actions')).toBe(true);
    bubble()!.querySelector<HTMLButtonElement>('.mention-tip-media-open')!.click();
    expect(openPastedText).toHaveBeenCalledWith('body text');
    expect(bubble()).toBeNull();
  });

  it('opens an editable dialog from the composer', () => {
    const editor = document.createElement('div');
    editor.className = 'ProseMirror';
    document.body.append(editor);
    const pill = pastedPill('body', editor);
    pill.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(actionLabels()).toEqual(['View text']);
    bubble()!.querySelector<HTMLButtonElement>('.mention-tip-media-open')!.click();
    expect(openPastedText).toHaveBeenCalledWith('body', expect.any(Function));
  });
});
