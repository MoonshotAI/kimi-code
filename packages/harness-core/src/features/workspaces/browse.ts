import { dirname, isAbsolute, join } from 'pathe';

import type { HostFileStat, OsFsPort } from '#/features/os/host/types';

import { mapHostFsError, WorkspaceFsError } from './errors';
import { buildEtag, classifyTextSample, FS_BINARY_SAMPLE_BYTES, guessMime } from './fileMeta';
import { RECENT_ROOTS_LIMIT, type FsBrowseEntry, type FsBrowseResponse, type FsHomeResponse } from './wire';

export interface FsContentProbe {
  readonly absolute: string;
  readonly size: number;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly isBinary: boolean;
  readonly etag: string;
  readonly mime: string;
  readonly mtimeMs: number;
}

export function createHostFsBrowser(
  fs: OsFsPort,
  homeDir: () => string,
  recentRoots: () => Promise<readonly string[]>,
): {
  browse(path?: string): Promise<FsBrowseResponse>;
  home(): Promise<FsHomeResponse>;
  probe(path: string): Promise<FsContentProbe>;
  mkdir(path: string): Promise<void>;
} {
  const browse = async (absPath?: string): Promise<FsBrowseResponse> => {
    const target = absPath ?? homeDir();
    if (!isAbsolute(target)) {
      throw new WorkspaceFsError('fs.not_absolute', `path must be absolute: ${target}`, { path: target });
    }
    let realTarget: string;
    try {
      realTarget = await fs.realpath(target);
    } catch (error) {
      throw mapHostFsError(error, target);
    }
    let dirents;
    try {
      dirents = await fs.readdir(realTarget);
    } catch (error) {
      throw mapHostFsError(error, realTarget);
    }
    const entries: FsBrowseEntry[] = dirents
      .filter((d) => d.isDirectory)
      .map((d) => ({
        name: d.name,
        path: join(realTarget, d.name),
        is_dir: true as const,
      }));
    entries.sort(compareBrowseEntries);
    const parent = dirname(realTarget);
    return {
      path: realTarget,
      parent: parent === realTarget ? null : parent,
      entries,
    };
  };

  const home = async (): Promise<FsHomeResponse> => {
    const roots = await recentRoots();
    return { home: homeDir(), recent_roots: roots.slice(0, RECENT_ROOTS_LIMIT) };
  };

  const probe = async (path: string): Promise<FsContentProbe> => {
    let abs: string;
    try {
      abs = await fs.realpath(path);
    } catch (error) {
      throw mapHostFsError(error, path);
    }
    let st: HostFileStat;
    try {
      st = await fs.stat(abs);
    } catch (error) {
      throw mapHostFsError(error, path);
    }
    if (st.isDirectory) {
      return {
        absolute: abs,
        size: st.size,
        isDirectory: true,
        isFile: false,
        isBinary: false,
        etag: buildEtag(st),
        mime: 'application/octet-stream',
        mtimeMs: st.mtimeMs ?? 0,
      };
    }
    const sampleSize = Math.min(FS_BINARY_SAMPLE_BYTES, st.size);
    const sample = sampleSize === 0 ? new Uint8Array() : await fs.readBytes(abs, sampleSize);
    const classification = classifyTextSample(sample);
    const isBinary = classification.isBinary || classification.encoding !== 'utf-8';
    return {
      absolute: abs,
      size: st.size,
      isDirectory: false,
      isFile: st.isFile,
      isBinary,
      etag: buildEtag(st),
      mime: guessMime(abs, isBinary),
      mtimeMs: st.mtimeMs ?? 0,
    };
  };

  const mkdirHost = async (path: string): Promise<void> => {
    try {
      await fs.mkdir(path);
    } catch (error) {
      throw mapHostFsError(error, path);
    }
  };

  return { browse, home, probe, mkdir: mkdirHost };
}

function compareBrowseEntries(a: FsBrowseEntry, b: FsBrowseEntry): number {
  const aDot = a.name.startsWith('.');
  const bDot = b.name.startsWith('.');
  if (aDot !== bDot) return aDot ? 1 : -1;
  return a.name.localeCompare(b.name);
}
