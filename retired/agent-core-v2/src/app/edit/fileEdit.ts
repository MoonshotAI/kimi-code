/**
 * `edit` domain (L4) — `IFileEditService` contract.
 *
 * App-scope general edit capability: reads a file through the os `hostFs`
 * domain (`IHostFileSystem`), applies the exact-string edit rules, and writes
 * the re-materialized content back. Returns a domain-neutral result (the
 * replacement count, or a ready-to-surface error) so consumers at any scope
 * can adapt it to their own shape; the Agent `EditTool` adapter turns it into
 * an `ExecutableToolResult`. Bound at App scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface FileEditInput {
  readonly path: string;
  readonly displayPath: string;
  readonly old_string: string;
  readonly new_string: string;
  readonly replace_all: boolean;
}

export type FileEditResult =
  | { readonly ok: true; readonly count: number }
  | { readonly ok: false; readonly error: string };

export interface IFileEditService {
  readonly _serviceBrand: undefined;

  edit(input: FileEditInput): Promise<FileEditResult>;
}

export const IFileEditService: ServiceIdentifier<IFileEditService> =
  createDecorator<IFileEditService>('fileEditService');
