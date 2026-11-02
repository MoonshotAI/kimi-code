import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { TextDecodeErrors } from '#/_base/execEnv/decodeText';

export interface HostFileStat {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink?: boolean;
  readonly size: number;
  readonly mtimeMs?: number;
  readonly ino?: number;
  readonly mode?: number;
}

export interface HostFileHead {
  readonly stat: HostFileStat;
  readonly bytes: Uint8Array;
}

export interface HostDirEntry {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink?: boolean;
}

export interface HostWalkEntry {
  readonly path: string;
  readonly kind: 'file' | 'directory' | 'symlink';
}

export interface HostWalkOptions {
  readonly ignore?: readonly string[];
  readonly deadlineMs?: number;
}

export type HostWalkVisitor = (entry: HostWalkEntry) => void | false | Promise<void | false>;

export interface IHostFileSystem {
  readonly _serviceBrand: undefined;

  readText(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: TextDecodeErrors },
  ): Promise<string>;
  writeText(path: string, data: string): Promise<void>;
  appendText(path: string, data: string): Promise<void>;
  readBytes(path: string, n?: number, offset?: number): Promise<Uint8Array>;
  readFileHead(path: string, maxBytes: number): Promise<HostFileHead>;
  writeBytes(path: string, data: Uint8Array | AsyncIterable<Uint8Array>): Promise<void>;
  readLines(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: TextDecodeErrors },
  ): AsyncGenerator<string>;
  createExclusive(path: string, data: Uint8Array): Promise<boolean>;
  stat(path: string): Promise<HostFileStat>;
  lstat(path: string): Promise<HostFileStat>;
  readdir(path: string): Promise<readonly HostDirEntry[]>;
  walk(path: string, options: HostWalkOptions, visit: HostWalkVisitor): Promise<{ readonly truncated: boolean }>;
  mkdir(path: string, options?: { readonly recursive?: boolean }): Promise<void>;
  remove(path: string): Promise<void>;
  rename?(from: string, to: string): Promise<void>;
  realpath(path: string): Promise<string>;
}

export const IHostFileSystem: ServiceIdentifier<IHostFileSystem> =
  createDecorator<IHostFileSystem>('hostFileSystem');
