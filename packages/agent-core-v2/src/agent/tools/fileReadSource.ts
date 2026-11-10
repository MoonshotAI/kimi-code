import { readUtf8Lines } from '#/_base/execEnv/decodeText';
import type { HostFileHead, HostFileStat, IHostFileSystem } from '#/os/interface/hostFileSystem';
import { parseDaemonFileUrl } from '#/agent/media/mediaRef';
import type { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import type { ExecutableToolResult } from '#/tool/toolContract';

export interface FileReadSource {
  readonly name: string;
  readonly localPath?: string;
  stat(): Promise<HostFileStat>;
  readHead(maxBytes: number): Promise<HostFileHead>;
  readBytes(n?: number): Promise<Uint8Array>;
  readLines(): AsyncIterable<string>;
}

export function withAttachmentLocation(result: ExecutableToolResult, source: FileReadSource): ExecutableToolResult {
  if (!result.isError || source.localPath === undefined || typeof result.output !== 'string') return result;
  return { ...result, output: `${result.output}\nServer-local attachment path: ${JSON.stringify(source.localPath)}` };
}

export function environmentFileSource(fs: IHostFileSystem, path: string): FileReadSource {
  return {
    name: path,
    stat: () => fs.stat(path),
    readHead: (maxBytes) => fs.readFileHead(path, maxBytes),
    readBytes: (n) => fs.readBytes(path, n),
    readLines: () => fs.readLines(path, { errors: 'strict' }),
  };
}

export async function attachmentFileSource(reference: string, store?: ISessionMediaStore): Promise<FileReadSource> {
  const ref = parseDaemonFileUrl(reference);
  const open = async () => {
    const file = ref === undefined ? undefined : await store?.open(ref.fileId);
    if (file === undefined) throw new Error(`Attachment ${JSON.stringify(reference)} is not available in the current session.`);
    return file;
  };
  const initial = await open();
  const stat = async (): Promise<HostFileStat> => ({ isFile: true, isDirectory: false, size: (await open()).size });
  const readBytes = async (n?: number): Promise<Uint8Array> => {
    const file = await open();
    const size = Math.min(n ?? file.size, file.size);
    if (size === 0) return new Uint8Array();
    const chunks: Buffer[] = [];
    for await (const chunk of file.stream({ start: 0, end: size - 1 })) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== size) throw new Error('Attachment changed or became unavailable while reading.');
    return bytes;
  };
  return {
    name: initial.name,
    localPath: initial.path,
    stat,
    readHead: async (maxBytes) => ({ stat: await stat(), bytes: await readBytes(maxBytes) }),
    readBytes,
    readLines: async function* () {
      const file = await open();
      const checkedStream = async function* () {
        let size = 0;
        for await (const chunk of file.stream()) {
          size += chunk.length;
          yield chunk;
        }
        if (size !== file.size) throw new Error('Attachment changed or became unavailable while reading.');
      };
      yield* readUtf8Lines(checkedStream());
    },
  };
}
