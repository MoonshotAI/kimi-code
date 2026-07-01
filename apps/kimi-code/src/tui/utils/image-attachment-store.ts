/**
 * Registry for media pasted into the input box.
 *
 * Each paste produces an `ImageAttachment` with an auto-incrementing id
 * or `VideoAttachment` with a human-readable placeholder (`[image #1
 * (640×480)]` / `[video #2 sample.mov]`). The placeholder is what the
 * user sees in the input field; on submit, `extractMediaAttachments`
 * walks the text and expands image placeholders to image content parts
 * and video placeholders to file-path tags for `ReadMediaFile`.
 *
 * Scope is per-`KimiTUI` instance. Reloads (`/new`, `/clear`,
 * session switch) call `clear()` so ids restart from 1 and stale
 * prompt attachments are dropped. We intentionally do NOT persist
 * attachments across sessions — coding-agent doesn't either, and
 * `--resume` wouldn't know how to materialize the files anyway.
 */

export interface ImageAttachment {
  readonly id: number;
  readonly kind: 'image';
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  /** Rendered placeholder string, e.g. `[image #1 (640×480)]`. */
  readonly placeholder: string;
}

export interface VideoAttachment {
  readonly id: number;
  readonly kind: 'video';
  readonly mime: string;
  readonly filename: string;
  readonly sourcePath: string;
  readonly label: string;
  /** Rendered placeholder string, e.g. `[video #1 sample.mov]`. */
  readonly placeholder: string;
}

export type MediaAttachment = ImageAttachment | VideoAttachment;

export class ImageAttachmentStore {
  private nextId = 1;
  private readonly byId = new Map<number, MediaAttachment>();

  addImage(bytes: Uint8Array, mime: string, width: number, height: number): ImageAttachment {
    const id = this.nextId;
    this.nextId += 1;
    const attachment: ImageAttachment = {
      id,
      kind: 'image',
      bytes,
      mime,
      width,
      height,
      placeholder: formatPlaceholder(id, width, height),
    };
    this.byId.set(id, attachment);
    return attachment;
  }

  addVideo(mime: string, sourcePath: string, filename?: string | undefined): VideoAttachment {
    const id = this.nextId;
    this.nextId += 1;
    const normalizedFilename = basenameLike(
      filename !== undefined && filename !== '' ? filename : sourcePath,
    );
    const label = sanitizeVideoLabel(normalizedFilename.length > 0 ? normalizedFilename : mime);
    const attachment: VideoAttachment = {
      id,
      kind: 'video',
      mime,
      filename: normalizedFilename,
      sourcePath,
      label,
      placeholder: formatVideoPlaceholder(id, label),
    };
    this.byId.set(id, attachment);
    return attachment;
  }

  get(id: number): MediaAttachment | undefined {
    return this.byId.get(id);
  }

  clear(): void {
    this.byId.clear();
    this.nextId = 1;
  }

  /**
   * Drop a single attachment, releasing its bytes. Used to reclaim image
   * memory once the transcript entry that references it is trimmed.
   */
  remove(id: number): void {
    this.byId.delete(id);
  }

  /** Drop many attachments at once. See {@link remove}. */
  removeMany(ids: Iterable<number>): void {
    for (const id of ids) this.byId.delete(id);
  }

  size(): number {
    return this.byId.size;
  }
}

export function formatPlaceholder(id: number, width: number, height: number): string {
  return `[image #${String(id)} (${String(width)}×${String(height)})]`;
}

export function formatVideoPlaceholder(id: number, label: string): string {
  return `[video #${String(id)} ${sanitizeVideoLabel(label)}]`;
}

function sanitizeVideoLabel(raw: string): string {
  let label = '';
  for (const char of raw) {
    const code = char.codePointAt(0);
    label +=
      code === undefined || code < 0x20 || code === 0x7f || char === '[' || char === ']'
        ? '_'
        : char;
  }
  label = label.trim();
  return label.length > 0 ? label : 'video';
}

function basenameLike(raw: string): string {
  const parts = raw.split(/[\\/]/).filter((part) => part.length > 0);
  return parts.at(-1) ?? raw;
}
