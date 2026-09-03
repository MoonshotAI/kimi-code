import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface SessionMediaMaterializeInput {
  readonly fileId: string;
  readonly size: number;
  readonly name: string;
  readonly mimeType: string;
  readonly stream: () => NodeJS.ReadableStream;
  readonly signal?: AbortSignal;
}

export interface SessionMediaReadRange {
  readonly start: number;
  readonly end: number;
}

export interface SessionMediaFile {
  readonly path?: string;
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  readonly stream: (range?: SessionMediaReadRange) => AsyncIterable<Uint8Array>;
}

export interface ISessionMediaStore {
  readonly _serviceBrand: undefined;

  pathFor(fileId: string, ext: string): string | undefined;

  resolveDisplayPath(fileId: string): Promise<string | undefined>;

  read(fileId: string): Promise<{ readonly data: Uint8Array; readonly name: string } | undefined>;

  open(fileId: string): Promise<SessionMediaFile | undefined>;

  materialize(input: SessionMediaMaterializeInput): Promise<string | undefined>;
}

export const ISessionMediaStore: ServiceIdentifier<ISessionMediaStore> =
  createDecorator<ISessionMediaStore>('sessionMediaStore');
