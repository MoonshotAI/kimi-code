import { basename, dirname, extname, join } from 'pathe';

import type { HostDirEntry, IHostFileSystem } from '#/os/interface/hostFileSystem';
import {
  classifyTextSample,
  decodeUtfText,
  splitByteOrderMark,
  type ByteOrderMark,
} from '#/_base/text/encoding';
import { dominantLineEnding } from '#/_base/text/line-endings';
import type { NewFileLineBreak } from './editorconfig';

const SIBLING_LIMIT = 5;
const SIBLING_SAMPLE_BYTES = 4 * 1024;

export interface NewFileSiblingStyle {
  readonly eol: NewFileLineBreak | undefined;
  readonly bom: ByteOrderMark | 'none' | undefined;
}

const EMPTY_STYLE: NewFileSiblingStyle = { eol: undefined, bom: undefined };

interface SiblingSample {
  readonly bom: ByteOrderMark | undefined;
  readonly eol: NewFileLineBreak | undefined;
}

async function sampleSibling(fs: IHostFileSystem, path: string): Promise<SiblingSample | undefined> {
  let bytes: Uint8Array;
  try {
    bytes = await fs.readBytes(path, SIBLING_SAMPLE_BYTES);
  } catch {
    return undefined;
  }
  if (bytes.length === 0) {
    return undefined;
  }
  const classification = classifyTextSample(bytes);
  if (classification.isBinary) {
    return undefined;
  }
  const { bom, body } = splitByteOrderMark(bytes);
  return { bom, eol: dominantLineEnding(decodeUtfText(body, bom ?? classification.encoding)) };
}

function tallyWinner<K>(tally: Map<K, number>): K | undefined {
  let best: K | undefined;
  let bestCount = 0;
  let tied = false;
  for (const [key, count] of tally) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
      tied = false;
    } else if (count === bestCount) {
      tied = true;
    }
  }
  return tied ? undefined : best;
}

export async function resolveSiblingStyle(
  fs: IHostFileSystem,
  targetPath: string,
): Promise<NewFileSiblingStyle> {
  const dir = dirname(targetPath);
  const name = basename(targetPath);
  let entries: readonly HostDirEntry[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return EMPTY_STYLE;
  }
  const extension = extname(name);
  const candidates = entries
    .filter((entry) => entry.isFile && entry.name !== name && extname(entry.name) === extension)
    .map((entry) => entry.name)
    .toSorted()
    .slice(0, SIBLING_LIMIT);

  const eolTally = new Map<NewFileLineBreak, number>();
  const bomTally = new Map<ByteOrderMark | 'none', number>();
  for (const candidate of candidates) {
    const style = await sampleSibling(fs, join(dir, candidate));
    if (style === undefined) continue;
    if (style.eol !== undefined) {
      eolTally.set(style.eol, (eolTally.get(style.eol) ?? 0) + 1);
    }
    const key = style.bom ?? 'none';
    bomTally.set(key, (bomTally.get(key) ?? 0) + 1);
  }
  const bomWinner = tallyWinner(bomTally);

  return {
    eol: tallyWinner(eolTally),
    bom: bomWinner,
  };
}
