import { isAbsolute, join, normalize, resolve } from 'node:path';

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

export const GIT_CONFIG_ARGS: readonly string[] = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  `core.hooksPath=${NULL_DEVICE}`,
  '-c',
  'commit.gpgSign=false',
  '-c',
  'log.showSignature=false',
  '-c',
  'merge.verifySignatures=false',
  '-c',
  'core.editor=',
  '-c',
  'gpg.program=',
  '-c',
  'submodule.recurse=false',
];

export const GIT_DIFF_ARGS: readonly string[] = ['--no-ext-diff', '--no-textconv'];

export const INCLUDE_SECTION_RE = /^\s*\[\s*include(?:\.|\s|\])/im;

export function parseGitDirPointer(content: string): string | undefined {
  const stripped = content.codePointAt(0) === 0xfeff ? content.slice(1) : content;
  const line = stripped.trimStart().split(/\r?\n/, 1)[0]?.trim();
  if (line === undefined || !line.startsWith('gitdir:')) return undefined;
  const rawPath = line.slice('gitdir:'.length).trim();
  return rawPath.length > 0 ? rawPath : undefined;
}

export function resolveConfigPaths(gitDir: string, commondirContent: string | undefined): string[] {
  const configPaths = [join(gitDir, 'config'), join(gitDir, 'config.worktree')];
  const commonDir = commondirContent?.trim();
  if (commonDir !== undefined && commonDir.length > 0) {
    configPaths.push(join(resolve(gitDir, commonDir), 'config'));
  }
  return configPaths;
}

export function buildDriverOverrides(outputs: readonly string[]): readonly string[] | null {
  const filterDrivers = new Set<string>();
  const mergeDrivers = new Set<string>();
  for (const output of outputs) {
    for (const line of output.split('\n')) {
      const filter = /^filter\.(.+)\.(?:clean|process|smudge)$/.exec(line);
      const filterDriver = filter?.[1];
      if (filterDriver !== undefined) {
        if (filterDriver.includes('=')) return null;
        filterDrivers.add(filterDriver);
      }
      const merge = /^merge\.(.+)\.driver$/.exec(line);
      const mergeDriver = merge?.[1];
      if (mergeDriver !== undefined) {
        if (mergeDriver.includes('=')) return null;
        mergeDrivers.add(mergeDriver);
      }
    }
  }
  const args: string[] = [];
  for (const driver of filterDrivers) {
    args.push(
      '-c',
      `filter.${driver}.clean=`,
      '-c',
      `filter.${driver}.process=`,
      '-c',
      `filter.${driver}.smudge=`,
    );
  }
  for (const driver of mergeDrivers) {
    args.push('-c', `merge.${driver}.driver=`);
  }
  return args;
}

export function isCoreWorktreeSafe(
  raw: string,
  resolvedGitDir: string,
  workTreeRoot: string,
): boolean {
  const configured = isAbsolute(raw) ? normalize(raw) : resolve(resolvedGitDir, raw);
  return normalize(configured) === normalize(workTreeRoot);
}
