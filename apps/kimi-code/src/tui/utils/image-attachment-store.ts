/**
 * Registry for media pasted into the input box.
 *
 * Each paste produces an `ImageAttachment` with an auto-incrementing id
 * or `VideoAttachment` with a human-readable placeholder (`[image #1
 * (640×480)]` / `[video #2 sample.mov]`). The placeholder is what the
 * user sees in the input field; on submit, `extractMediaAttachments`
 * walks the text and expands image placeholders to image content parts
 * (dispatch-time caption resolution then precedes them with a compression
 * caption when paste-time compression shrank the bytes — see
 * `ImageAttachment.original`) and video placeholders to file-path tags
 * for `ReadMediaFile`.
 *
 * Scope is per-`KimiTUI` instance. Reloads (`/new`, `/clear`,
 * session switch) call `clear()` so ids restart from 1 and stale
 * prompt attachments are dropped. We intentionally do NOT persist
 * attachments across sessions — coding-agent doesn't either, and
 * `--resume` wouldn't know how to materialize the files anyway.
 */

export interface ImageAttachmentOriginal {
  /**
   * Pre-compression bytes, kept in memory until dispatch-time caption
   * resolution (`resolveOriginalCaptions`) persists them — the session whose
   * media-originals dir they belong in may not exist yet at paste time.
   * Released once persistence succeeds; the on-disk copy is the original
   * from then on.
   */
  bytes?: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** Pre-compression size, retained for captions after `bytes` is released. */
  readonly byteLength: number;
  readonly mime: string;
  /**
   * Where the original was persisted for readback (ReadMediaFile + region).
   * Undefined until dispatch-time persistence succeeds; failures are retried
   * at the next dispatch.
   */
  path?: string;
}

export interface ImageAttachment {
  readonly id: number;
  readonly kind: 'image';
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  /**
   * Pre-compression original, recorded when paste-time compression changed
   * the bytes. Drives the compression caption authored on dispatch so the
   * model knows it received a downsampled copy. Absent for untouched pastes.
   */
  readonly original?: ImageAttachmentOriginal | undefined;
  /**
   * Daemon file-store id, set when the bytes were uploaded at paste time
   * (v2 engine only). Submit-time expansion then emits a `kimi-file://`
   * reference plus an `<image path>` tag instead of inline base64; absent
   * means the inline form is used.
   */
  fileId?: string;
  /** Epoch milliseconds when the daemon staging upload expires. */
  fileExpiresAt?: number;
  /**
   * Background ingestion (compression/daemon upload) still in flight. The
   * paste callback settles once the placeholder is in the editor — typing
   * never waits on this — but submit holds it briefly
   * (`pendingImageIngestions`) so a fast paste-then-Enter still gets the
   * compressed/ref form; a slow ingestion submits the inline form instead.
   * Cleared when ingestion completes.
   */
  pending?: Promise<void>;
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

type MutableImageAttachment = {
  -readonly [Property in keyof ImageAttachment]: ImageAttachment[Property];
};

type MutableVideoAttachment = {
  -readonly [Property in keyof VideoAttachment]: VideoAttachment[Property];
};

export class ImageAttachmentStore {
  private nextId = 1;
  private readonly byId = new Map<number, MediaAttachment>();
  private readonly stagingUses = new Map<number, number>();

  addImage(
    bytes: Uint8Array,
    mime: string,
    width: number,
    height: number,
    original?: ImageAttachmentOriginal,
    fileId?: string,
    fileExpiresAt?: number,
  ): ImageAttachment {
    const id = this.nextId;
    this.nextId += 1;
    const attachment: ImageAttachment = {
      id,
      kind: 'image',
      bytes,
      mime,
      width,
      height,
      original,
      fileId,
      fileExpiresAt,
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

  /**
   * Complete an image that was inserted into the editor before its ingestion
   * work (compression/upload) finished. Returns undefined when the attachment
   * was cleared while that work was in flight.
   */
  completeImage(
    attachment: ImageAttachment,
    input: {
      bytes: Uint8Array;
      mime: string;
      width: number;
      height: number;
      original?: ImageAttachmentOriginal;
      fileId?: string;
      fileExpiresAt?: number;
    },
  ): ImageAttachment | undefined {
    const current = this.byId.get(attachment.id);
    if (current !== attachment || attachment.kind !== 'image') return undefined;
    const mutable = attachment as MutableImageAttachment;
    mutable.bytes = input.bytes;
    mutable.mime = input.mime;
    mutable.width = input.width;
    mutable.height = input.height;
    mutable.original = input.original;
    mutable.fileId = input.fileId;
    mutable.fileExpiresAt = input.fileExpiresAt;
    mutable.pending = undefined;
    mutable.placeholder = formatPlaceholder(attachment.id, input.width, input.height);
    return attachment;
  }

  /**
   * Record where an attachment's pre-compression original was persisted and
   * release the in-memory buffer — the on-disk copy is the original from
   * then on, and the caption only needs the retained metadata. Dispatch-time
   * caption resolution calls this after a successful write; failures leave
   * the path unset so a later dispatch retries.
   */
  setOriginalPath(id: number, path: string): void {
    const attachment = this.byId.get(id);
    if (attachment?.kind !== 'image' || attachment.original === undefined) return;
    attachment.original.path = path;
    attachment.original.bytes = undefined;
  }

  get(id: number): MediaAttachment | undefined {
    return this.byId.get(id);
  }

  clear(): readonly string[] {
    const fileIds = this.fileIds();
    this.byId.clear();
    this.stagingUses.clear();
    this.nextId = 1;
    return fileIds;
  }

  /**
   * Drop a single attachment, releasing its bytes. Used to reclaim image
   * memory once the transcript entry that references it is trimmed.
   */
  remove(id: number): string | undefined {
    const attachment = this.byId.get(id);
    const fileId = attachment?.kind === 'image' ? attachment.fileId : undefined;
    this.byId.delete(id);
    this.stagingUses.delete(id);
    return fileId;
  }

  /** Drop many attachments at once. See {@link remove}. */
  removeMany(ids: Iterable<number>): readonly string[] {
    const fileIds: string[] = [];
    for (const id of ids) {
      const fileId = this.remove(id);
      if (fileId !== undefined) fileIds.push(fileId);
    }
    return fileIds;
  }

  retainFileIds(ids: Iterable<number>): void {
    const retained = new Set<number>();
    for (const id of ids) {
      if (retained.has(id)) continue;
      retained.add(id);
      const attachment = this.byId.get(id);
      if (attachment?.kind !== 'image' || attachment.fileId === undefined) continue;
      this.stagingUses.set(id, (this.stagingUses.get(id) ?? 0) + 1);
    }
  }

  takeFileIds(ids: Iterable<number>): readonly string[] {
    const fileIds: string[] = [];
    const taken = new Set<number>();
    for (const id of ids) {
      if (taken.has(id)) continue;
      taken.add(id);
      const attachment = this.byId.get(id);
      if (attachment?.kind !== 'image' || attachment.fileId === undefined) continue;
      const uses = this.stagingUses.get(id) ?? 0;
      if (uses > 1) {
        this.stagingUses.set(id, uses - 1);
        continue;
      }
      this.stagingUses.delete(id);
      fileIds.push(attachment.fileId);
      attachment.fileId = undefined;
      attachment.fileExpiresAt = undefined;
    }
    return fileIds;
  }

  /**
   * Consume the retains a recalled submission held WITHOUT taking the staged
   * files: the recalled draft still references the attachments, so their
   * daemon uploads stay alive and the next submit re-retains them. Used by
   * queue recall; every other release path goes through {@link takeFileIds}.
   */
  releaseRetains(ids: Iterable<number>): void {
    const released = new Set<number>();
    for (const id of ids) {
      if (released.has(id)) continue;
      released.add(id);
      const uses = this.stagingUses.get(id) ?? 0;
      if (uses > 1) this.stagingUses.set(id, uses - 1);
      else this.stagingUses.delete(id);
    }
  }

  /**
   * Repoint a recalled video at its staged cache copy: the original source
   * (e.g. a clipboard temp file) may be gone by the time the restored draft
   * is resubmitted, and re-extraction re-materializes from `sourcePath`.
   */
  rebaseVideoSource(id: number, sourcePath: string): void {
    const attachment = this.byId.get(id);
    if (attachment?.kind !== 'video') return;
    (attachment as MutableVideoAttachment).sourcePath = sourcePath;
  }

  private fileIds(): readonly string[] {
    return [...this.byId.values()]
      .filter((attachment): attachment is ImageAttachment => attachment.kind === 'image')
      .flatMap((attachment) => attachment.fileId ?? []);
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
