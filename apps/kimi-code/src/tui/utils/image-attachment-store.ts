export interface ImageAttachmentOriginal {
  bytes?: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly mime: string;
  path?: string;
  attachment?: { readonly sessionId: string; readonly reference: string };
}

export interface ImageAttachment {
  readonly id: number;
  readonly kind: 'image';
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  readonly original?: ImageAttachmentOriginal | undefined;
  fileId?: string;
  fileExpiresAt?: number;
  pending?: Promise<void>;
  readonly placeholder: string;
}

export interface VideoAttachment {
  readonly id: number;
  readonly kind: 'video';
  readonly mime: string;
  readonly filename: string;
  readonly sourcePath: string;
  readonly label: string;
  fileId?: string;
  fileExpiresAt?: number;
  pending?: Promise<void>;
  readonly placeholder: string;
}

export type MediaAttachment = ImageAttachment | VideoAttachment;

type MutableImageAttachment = {
  -readonly [Property in keyof ImageAttachment]: ImageAttachment[Property];
};

export class ImageAttachmentStore {
  private nextId = 1;
  private currentGeneration = 0;
  private readonly byId = new Map<number, MediaAttachment>();
  private readonly stagingUses = new Map<number, number>();

  get generation(): number {
    return this.currentGeneration;
  }

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

  addVideo(mime: string, sourcePath: string, filename?: string): VideoAttachment {
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

  completeVideo(
    attachment: VideoAttachment,
    input: {
      fileId?: string;
      fileExpiresAt?: number;
    },
  ): VideoAttachment | undefined {
    const current = this.byId.get(attachment.id);
    if (current !== attachment || attachment.kind !== 'video') return undefined;
    attachment.fileId = input.fileId;
    attachment.fileExpiresAt = input.fileExpiresAt;
    attachment.pending = undefined;
    return attachment;
  }

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
    const fileIds = this.fileIds((id) => (this.stagingUses.get(id) ?? 0) === 0);
    this.byId.clear();
    this.stagingUses.clear();
    this.nextId = 1;
    this.currentGeneration += 1;
    return fileIds;
  }

  remove(id: number): string | undefined {
    const attachment = this.byId.get(id);
    const fileId = attachment?.fileId;
    this.byId.delete(id);
    this.stagingUses.delete(id);
    return fileId;
  }

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
      if (attachment?.fileId === undefined) continue;
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
      if (attachment?.fileId === undefined) continue;
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

  private fileIds(include?: (id: number) => boolean): readonly string[] {
    return [...this.byId.values()].flatMap((attachment) =>
      attachment.fileId !== undefined && (include?.(attachment.id) ?? true)
        ? [attachment.fileId]
        : [],
    );
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
