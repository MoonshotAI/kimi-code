import { createFeature, useApp, type App, type Feature } from '@moonshot-ai/agent-core/app/index';
import { createFacadeToken, useExpose } from '@moonshot-ai/agent-core/kernel/index';

import { FileLibrary, type FileMeta, type SaveFileOptions, type StoredFile } from './store';

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

export function createFiles(props: CreateFilesProps): Feature<void> {
  const libraries = new WeakMap<App, FileLibrary>();
  return createFeature('files', {
    app() {
      const app = useApp();
      let library = libraries.get(app);
      if (library === undefined) {
        library = new FileLibrary(props.dir);
        libraries.set(app, library);
      }
      useExpose(FilesRef, library);
    },
  });
}
