import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { unwrapErrorCause } from '#/_base/errors/errors';
import {
  byteOrderMarkBytes,
  decodeUnicodeText,
  encodeUnicodeText,
  splitByteOrderMark,
  type ByteOrderMark,
} from '#/_base/text/encoding';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';

import { EditService } from './editService';
import { type FileEditInput, type FileEditResult, IFileEditService } from './fileEdit';
import { TextModel } from './textModel';

const BOM_SNIFF_BYTES = 4;

async function readBomText(fs: IHostFileSystem, path: string, bom: ByteOrderMark): Promise<string> {
  if (fs.clientBackedText) {
    return fs.readText(path);
  }
  const bytes = await fs.readBytes(path);
  return decodeUnicodeText(splitByteOrderMark(bytes).body, bom);
}

export class FileEditService implements IFileEditService {
  declare readonly _serviceBrand: undefined;

  private readonly editor: EditService;

  constructor(@IHostFileSystem private readonly fs: IHostFileSystem) {
    this.editor = new EditService();
  }

  async edit(input: FileEditInput, fs: IHostFileSystem = this.fs): Promise<FileEditResult> {
    try {
      let bom: ByteOrderMark | undefined;
      try {
        bom = splitByteOrderMark(await fs.readBytes(input.path, BOM_SNIFF_BYTES)).bom;
      } catch {}
      const raw = bom === undefined
        ? await fs.readText(input.path, { errors: 'strict' })
        : await readBomText(fs, input.path, bom);
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
      if (bom === undefined) {
        await fs.writeText(input.path, result.rawContent);
      } else {
        const mark = byteOrderMarkBytes(bom);
        const body = encodeUnicodeText(result.rawContent, bom);
        const payload = new Uint8Array(mark.length + body.length);
        payload.set(mark, 0);
        payload.set(body, mark.length);
        await fs.writeBytes(input.path, payload);
      }
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
