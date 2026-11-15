import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createZstdDecompress } from 'node:zlib';
import { isRequestLogLine } from '#/claude-code';
import { writeAttachmentFile } from '#/images';
import type { ConversionIssue, EffectiveHistory, SessionSource, SourceCopy } from '#/types';

export async function saveEffectiveHistory(
  history: EffectiveHistory,
  directory: string,
  issues: readonly ConversionIssue[],
): Promise<string> {
  function* lines(): Generator<string> {
    const { turns, ...header } = history;
    yield JSON.stringify({ type: 'session', format: 'kimi-import-history', version: 1, ...header, issues }) + '\n';
    for (const turn of turns) yield JSON.stringify({ type: 'turn', ...turn }) + '\n';
  }
  const hash = createHash('sha256');
  for (const line of lines()) hash.update(line);
  const filename = `effective-history-${hash.digest('hex')}.jsonl`;
  async function* chunks(): AsyncGenerator<Uint8Array> {
    for (const line of lines()) yield Buffer.from(line);
  }
  return (await writeAttachmentFile(directory, filename, chunks())).path;
}

async function* keptLines(path: string, keep: (line: Buffer) => boolean): AsyncGenerator<Uint8Array> {
  const file = createReadStream(path);
  const decompressor = path.endsWith('.zst') ? createZstdDecompress() : undefined;
  const stream = decompressor ? file.pipe(decompressor) : file;
  if (decompressor) file.on('error', error => decompressor.destroy(error));
  let pending: Buffer[] = [];
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      let start = 0;
      for (let end = chunk.indexOf(10); end >= 0; end = chunk.indexOf(10, start)) {
        pending.push(chunk.subarray(start, end + 1));
        const line = Buffer.concat(pending);
        pending = [];
        if (keep(line)) yield line;
        start = end + 1;
      }
      if (start < chunk.length) pending.push(chunk.subarray(start));
    }
    const tail = Buffer.concat(pending);
    if (tail.length > 0 && keep(tail)) yield tail;
  } finally {
    file.destroy();
    decompressor?.destroy();
  }
}

async function copyFolder(source: string, destination: string, keep: (line: Buffer) => boolean): Promise<number> {
  let copied = 0;
  for (const entry of await readdir(source, { withFileTypes: true }).catch(() => [])) {
    const path = join(source, entry.name);
    if (entry.isDirectory()) copied += await copyFolder(path, join(destination, entry.name), keep);
    else if (entry.isFile()) {
      await writeAttachmentFile(destination, entry.name, entry.name.endsWith('.jsonl') ? keptLines(path, keep) : createReadStream(path));
      copied++;
    }
  }
  return copied;
}

export async function saveSourceCopy(source: SessionSource, sourcePath: string, attachmentDirectory: string, subagentPaths: readonly string[] = []): Promise<SourceCopy> {
  const directory = join(attachmentDirectory, 'source');
  const keep = source === 'claude-code' ? (line: Buffer) => !isRequestLogLine(line) : () => true;
  await writeAttachmentFile(directory, basename(sourcePath).replace(/\.zst$/, ''), keptLines(sourcePath, keep));
  const session = basename(sourcePath, '.jsonl');
  const folder = source === 'claude-code' && await copyFolder(join(dirname(sourcePath), session), join(directory, session), keep) > 0;
  for (const path of subagentPaths) await writeAttachmentFile(join(directory, 'subagents'), basename(path).replace(/\.zst$/, ''), keptLines(path, keep));
  return { directory, folder, subagentRollouts: subagentPaths.length };
}
