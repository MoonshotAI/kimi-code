export interface TooltipHoverRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface TooltipAttachmentPill {
  attId: string;
  kind: 'file' | 'folder' | 'image' | 'video';
  name: string;
  size?: number;
}

export function isPointInTooltipHoverRegion(
  x: number,
  y: number,
  anchorRect: TooltipHoverRect,
  bubbleRect: TooltipHoverRect,
  anchorSlop = 4,
  bubbleSlop = 6,
): boolean {
  const inside = (rect: TooltipHoverRect, padding: number): boolean =>
    x >= rect.left - padding &&
    x <= rect.right + padding &&
    y >= rect.top - padding &&
    y <= rect.bottom + padding;
  return inside(anchorRect, anchorSlop) || inside(bubbleRect, bubbleSlop);
}

export function isBubbleInternalScroll(bubble: HTMLElement | null, target: EventTarget | null): boolean {
  return (
    bubble !== null &&
    target !== null &&
    typeof Node !== 'undefined' &&
    target instanceof Node &&
    bubble.contains(target)
  );
}

export function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function mediaProgressRingDash(progress: number): string {
  const clamped = Math.min(1, Math.max(0, progress));
  return `${(clamped * 40.84).toFixed(1)} 40.84`;
}

export function pillMention(pill: HTMLElement): { kind: string; name: string; path: string } {
  const kind =
    pill.dataset.mentionKind ??
    (pill.classList.contains('mention-skill')
      ? 'skill'
      : pill.classList.contains('mention-folder')
        ? 'folder'
        : 'file');
  const name = pill.dataset.mentionName ?? pill.querySelector('.mention-pill-name')?.textContent ?? '';
  return { kind, name, path: pill.dataset.mentionPath ?? '' };
}

export function pillAttachment(pill: HTMLElement): TooltipAttachmentPill {
  const rawKind = pill.dataset.attachmentKind;
  const kind = rawKind === 'folder' || rawKind === 'image' || rawKind === 'video' ? rawKind : 'file';
  const name = pill.dataset.attachmentName ?? pill.querySelector('.attachment-pill-name')?.textContent ?? '';
  const rawSize = pill.dataset.attachmentSize;
  const size = rawSize === undefined || rawSize === '' ? undefined : Number(rawSize);
  return {
    attId: pill.dataset.attachmentId ?? '',
    kind,
    name,
    size: size !== undefined && Number.isFinite(size) ? size : undefined,
  };
}

const tooltipOwnerIds = new WeakMap<HTMLElement, number>();
let nextTooltipOwnerId = 1;

function ownerId(owner: HTMLElement): number {
  let id = tooltipOwnerIds.get(owner);
  if (id === undefined) {
    id = nextTooltipOwnerId++;
    tooltipOwnerIds.set(owner, id);
  }
  return id;
}

export function tooltipPillIdentity(pill: HTMLElement): string | null {
  if (!pill.classList.contains('attachment-pill')) return null;
  const editor = pill.closest<HTMLElement>('.ProseMirror');
  const owner = editor
    ? `composer:${ownerId(editor)}`
    : (() => {
        const turnId = pill.closest<HTMLElement>('[data-turn-id]')?.dataset.turnId ?? '';
        const fileId = pill.dataset.attachmentFileId ?? '';
        const sessionId = pill.dataset.attachmentSessionId ?? '';
        if (turnId === '' && fileId === '') return null;
        return `message:${turnId}:${sessionId}:${fileId}`;
      })();
  if (owner === null) return null;
  return JSON.stringify([
    owner,
    pill.dataset.attachmentId ?? '',
    pill.dataset.attachmentKind ?? '',
    pill.dataset.attachmentName ?? '',
  ]);
}

export function isSameTooltipPill(first: HTMLElement, second: HTMLElement): boolean {
  const firstIdentity = tooltipPillIdentity(first);
  return firstIdentity !== null && firstIdentity === tooltipPillIdentity(second);
}

export function consumeSelectedMediaEscape(
  event: Pick<KeyboardEvent, 'preventDefault' | 'stopImmediatePropagation'>,
  selected: HTMLElement | null,
  dismissSelection: (editor: HTMLElement) => boolean,
): boolean {
  if (selected === null) return false;
  const editor = selected.closest<HTMLElement>('.ProseMirror');
  if (editor !== null) dismissSelection(editor);
  event.preventDefault();
  event.stopImmediatePropagation();
  return true;
}
