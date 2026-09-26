import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { unwrapErrorCause } from '#/_base/errors/errors';
import {
  hasUtf32ByteOrderMark,
  isStrictlyValidUtf8,
  splitByteOrderMark,
  type ByteOrderMark,
} from '#/_base/text/encoding';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';

import { EditService } from './editService';
import { type FileEditInput, type FileEditResult, IFileEditService } from './fileEdit';
import { TextModel } from './textModel';

interface ByteOrderMarkProbe {
  readonly bom: ByteOrderMark | undefined;
  readonly unsupported: boolean;
}

async function probeByteOrderMark(
  fs: IHostFileSystem,
  path: string,
): Promise<ByteOrderMarkProbe> {
  try {
    const head = await fs.readBytes(path);
    if (hasUtf32ByteOrderMark(head)) {
      return { bom: undefined, unsupported: true };
    }
    const { bom, body } = splitByteOrderMark(head);
    if (bom !== undefined && bom !== 'utf-8') {
      return { bom, unsupported: false };
    }
    if (bom === 'utf-8') {
      return { bom, unsupported: !isStrictlyValidUtf8(body, true) };
    }
    return { bom: undefined, unsupported: !isStrictlyValidUtf8(head, true) };
  } catch (error) {
    if ((unwrapErrorCause(error) as { code?: unknown } | null)?.code === 'ENOENT') {
      return { bom: undefined, unsupported: false };
    }
    throw error;
  }
}

export class FileEditService implements IFileEditService {
  declare readonly _serviceBrand: undefined;

  private readonly editor: EditService;

  constructor(@IHostFileSystem private readonly fs: IHostFileSystem) {
    this.editor = new EditService();
  }

  async edit(input: FileEditInput, fs: IHostFileSystem = this.fs): Promise<FileEditResult> {
    try {
      const probe = await probeByteOrderMark(fs, input.path);
      if (probe.unsupported || (probe.bom !== undefined && probe.bom !== 'utf-8')) {
        return { ok: false, error: `${input.displayPath} is not a UTF-8 text file.` };
      }
      const raw = await fs.readText(input.path, { errors: 'strict' });
      const content =
        probe.bom === 'utf-8' && raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
      const model = new TextModel(content);
      const result = this.editor.apply(model, {
        path: input.displayPath,
        old_string: input.old_string,
        new_string: input.new_string,
        replace_all: input.replace_all,
      });
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      const materialized = result.rawContent;
      const needsBom = probe.bom === 'utf-8' && !materialized.startsWith('\uFEFF');
      await fs.writeText(input.path, needsBom ? '\uFEFF' + materialized : materialized);
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
  ScopeActivation.OnScopeCreated,
  'edit',
);
