import { createFacadeToken, createFeature, type FeatureSpec } from '@moonshot-ai/agent-core';
import { useExpose } from '@moonshot-ai/agent-core/kernel/index';

import {
  FileLibrary,
  type FileMeta,
  type SaveFileOptions,
  type StoredFile,
} from './store';

export interface FilesFace {
  save(
    source: AsyncIterable<Uint8Array>,
    filename: string,
    options?: SaveFileOptions,
  ): Promise<FileMeta>;
  open(id: string): Promise<StoredFile | undefined>;
}

export const FilesRef = createFacadeToken<FilesFace>('files');

export interface CreateFilesProps {
  readonly dir: string;
}

export function createFiles(props: CreateFilesProps): FeatureSpec {
  return createFeature('files', {
    app() {
      useExpose(FilesRef, new FileLibrary(props.dir));
    },
  });
}
