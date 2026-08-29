import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

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

  edit(input: FileEditInput, fs?: IHostFileSystem): Promise<FileEditResult>;
}

export const IFileEditService: ServiceIdentifier<IFileEditService> =
  createDecorator<IFileEditService>('fileEditService');
