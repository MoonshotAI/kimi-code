export interface MediaContent {
  readonly bytes: Uint8Array;
  readonly mimeType?: string;
  readonly filename?: string;
}

export interface MediaSource {
  get(ref: string): Promise<MediaContent | undefined>;
}
