import { posix, win32 } from 'node:path';

export function pathFlavor(platform) {
  return platform === 'win32'
    ? {
        delimiter: ';',
        sep: '\\',
        join: win32.join,
        dirname: win32.dirname,
        extname: win32.extname,
      }
    : {
        delimiter: ':',
        sep: '/',
        join: posix.join,
        dirname: posix.dirname,
        extname: posix.extname,
      };
}

export function executableCandidates(basename, platform = process.platform) {
  if (platform !== 'win32') return [basename];
  const pathext = (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM')
    .toLowerCase()
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean);
  return [basename, ...pathext.map((ext) => basename + ext)];
}
