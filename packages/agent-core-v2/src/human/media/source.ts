export interface MediaContent {
  readonly bytes: Uint8Array;
  readonly mimeType?: string;
  readonly filename?: string;
}

export interface MediaSource {
  get(ref: string): Promise<MediaContent | undefined>;
}

export interface MemoryMediaSource extends MediaSource {
  set(ref: string, content: MediaContent): void;
}

export function createMemoryMediaSource(
  entries?: Readonly<Record<string, MediaContent>>,
): MemoryMediaSource {
  const map = new Map<string, MediaContent>(Object.entries(entries ?? {}));
  return {
    get: (ref) => Promise.resolve(map.get(ref)),
    set: (ref, content) => {
      map.set(ref, content);
    },
  };
}
