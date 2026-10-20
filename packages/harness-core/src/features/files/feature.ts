import { createFeature, useApp, type App, type Feature } from '@moonshot-ai/agent-core/app/index';
import { createFacadeToken, useExpose, useInject } from '@moonshot-ai/agent-core/kernel/index';

import { useBlobs, useFeatureStore } from '#/runtime/index';

import { createKimiFileRegistry, kimiFileProjection, KimiFileRegistryRef } from './registry';
import { FileLibrary, type FilesFace } from './store';

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
    session() {
      const files = useInject(FilesRef);
      const store = useFeatureStore('session', 'files', kimiFileProjection);
      useExpose(
        KimiFileRegistryRef,
        createKimiFileRegistry({
          blobs: useBlobs(),
          store,
          files: () => files.value,
        }),
      );
    },
  });
}
