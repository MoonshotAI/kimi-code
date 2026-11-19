// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startMentionTooltip } from '../../src/transcript/mentionTooltip';

const MoveEvent: typeof MouseEvent = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;

function move(target: Element, x: number, y: number): void {
  target.dispatchEvent(new MoveEvent('pointermove', { bubbles: true, clientX: x, clientY: y }));
}

function selectedMediaEditor(): { editor: HTMLElement; pill: HTMLElement } {
  const editor = document.createElement('div');
  editor.className = 'ProseMirror ProseMirror-focused';
  editor.tabIndex = 0;
  const pill = document.createElement('span');
  pill.className = 'attachment-pill ProseMirror-selectednode attachment-image';
  pill.dataset.attachmentId = 'att-1';
  pill.dataset.attachmentKind = 'image';
  pill.dataset.attachmentName = 'shot.png';
  editor.append(pill);
  document.body.append(editor);
  return { editor, pill };
}

let stop: (() => void) | null = null;

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  stop = startMentionTooltip({});
  move(document.body, 1, 1);
  move(document.body, 2, 2);
});

afterEach(() => {
  stop?.();
  stop = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('mention tooltip pointer tracking', () => {
  it('does not scan the whole document on pointer moves while no editor is focused', () => {
    const scan = vi.spyOn(document, 'querySelectorAll');
    move(document.body, 30, 30);
    move(document.body, 31, 32);
    expect(scan).not.toHaveBeenCalled();
  });

  it('still finds the selected media pill inside the focused editor', () => {
    const { editor, pill } = selectedMediaEditor();
    editor.focus();
    expect(document.activeElement).toBe(editor);

    move(editor, 40, 40);

    expect(pill.getAttribute('aria-describedby')).toBeTruthy();
  });

  it('ignores a selected pill inside an editor that is not focused', () => {
    const { editor, pill } = selectedMediaEditor();
    editor.classList.remove('ProseMirror-focused');

    move(editor, 40, 40);

    expect(pill.getAttribute('aria-describedby')).toBeNull();
  });

  it('keeps the selected media tooltip open on document scroll', () => {
    const { editor, pill } = selectedMediaEditor();
    editor.focus();
    move(editor, 40, 40);
    expect(pill.getAttribute('aria-describedby')).toBeTruthy();

    editor.dispatchEvent(new Event('scroll'));

    expect(pill.getAttribute('aria-describedby')).toBeTruthy();
  });

  it('opens same-name skill variants by their own paths and preserves legacy default resolution', () => {
    const skills = [
      { name: 'review-pr', description: 'Primary', path: '/work/code-app/review-pr/SKILL.md' },
      { name: 'review-pr', description: 'Secondary', path: '/work/kimi-code/review-pr/SKILL.md' },
    ];
    const opened: string[] = [];
    stop?.();
    stop = startMentionTooltip({
      resolveSkill: (name, path) => skills.find((skill) => skill.name === name && (path === undefined || skill.path === path)) ?? null,
      openPath: ({ path }) => opened.push(path),
    });
    const pill = document.createElement('a');
    pill.className = 'mention-pill mention-skill';
    pill.dataset.mentionKind = 'skill';
    pill.dataset.mentionName = 'review-pr';
    document.body.append(pill);

    for (const [path, expected] of [
      [skills[1]!.path, skills[1]!.path],
      [skills[0]!.path, skills[0]!.path],
      ['', skills[0]!.path],
    ]) {
      pill.dataset.mentionPath = path;
      pill.click();
      expect(opened.at(-1)).toBe(expected);
    }
    expect(opened).toHaveLength(3);
  });
});

describe('URL-only media previews', () => {
  it.each([
    { kind: 'image', url: 'data:image/png;base64,AA==', selector: 'img' },
    { kind: 'video', url: 'https://example.test/demo.mp4', selector: 'video' },
  ])('renders the retained URL for $kind attachments without a file id', async ({ kind, url, selector }) => {
    vi.useFakeTimers();
    const pill = document.createElement('span');
    pill.className = `attachment-pill attachment-${kind}`;
    pill.dataset.attachmentId = 'm1';
    pill.dataset.attachmentKind = kind;
    pill.dataset.attachmentName = kind === 'image' ? 'shot.png' : 'demo.mp4';
    pill.dataset.attachmentUrl = url;
    document.body.append(pill);

    move(pill, 20, 20);
    await vi.runOnlyPendingTimersAsync();

    const preview = document.querySelector<HTMLElement>(`${selector}.mention-tip-media-el`);
    expect(preview?.getAttribute('src')).toBe(url);
    expect(document.querySelector('.mention-tip-media-hint')?.textContent).not.toBe('unavailable');
  });
});
