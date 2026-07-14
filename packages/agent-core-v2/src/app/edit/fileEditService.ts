/**
 * `edit` domain (L4) — `IFileEditService` implementation.
 *
 * Reads the file through the os `hostFs` domain (`IHostFileSystem`), runs the
 * pure edit logic (`TextModel` + `EditService`), and writes the re-materialized
 * content back. Maps host-level failures (e.g. `EISDIR`) to the domain-neutral
 * `FileEditResult`; it owns no tool-facing message, which the Agent `EditTool`
 * adapter supplies. Bound at App scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { unwrapErrorCause } from '#/_base/errors/errors';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';

import { EditService } from './editService';
import { type FileEditInput, type FileEditResult, IFileEditService } from './fileEdit';
import { TextModel } from './textModel';

export class FileEditService implements IFileEditService {
  declare readonly _serviceBrand: undefined;

  private readonly editor: EditService;

  constructor(@IHostFileSystem private readonly fs: IHostFileSystem) {
    this.editor = new EditService();
  }

  async edit(input: FileEditInput): Promise<FileEditResult> {
    try {
      const raw = await this.fs.readText(input.path, { errors: 'strict' });
      const model = new TextModel(raw);
      const result = this.editor.apply(model, {
        path: input.displayPath,
        old_string: input.old_string,
        new_string: input.new_string,
        replace_all: input.replace_all,
      });
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      await this.fs.writeText(input.path, result.rawContent);
      return { ok: true, count: result.count };
    } catch (error) {
      const code = (unwrapErrorCause(error) as { code?: unknown } | null)?.code;
      if (code === 'EISDIR') {
        return { ok: false, error: `${input.displayPath} is not a file.` };
      }
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

registerScopedService(
  LifecycleScope.App,
  IFileEditService,
  FileEditService,
  InstantiationType.Delayed,
  'edit',
);
