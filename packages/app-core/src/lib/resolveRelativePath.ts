
export function resolveRelativePath(src: string, base: string): string {
  let root = '';
  let rest = base;
  const unc = /^((?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+)/.exec(base);
  const drive = /^([a-zA-Z]:)[\\/]?/.exec(base);
  if (unc) {
    root = unc[1]!;
    rest = base.slice(unc[1]!.length);
  } else if (base.startsWith('/')) {
    root = '/';
    rest = base.slice(1);
  } else if (drive) {
    root = drive[1]!;
    rest = base.slice(drive[0].length);
  }
  const absolute = root !== '';
  const result = rest.split(/[\\/]+/).filter(Boolean);
  for (const part of src.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (result.length > 0 && result[result.length - 1] !== '..') result.pop();
      else if (!absolute) result.push('..');
    } else {
      result.push(part);
    }
  }
  const joined = result.join('/');
  if (root === '/') return `/${joined}`;
  if (root !== '') return joined ? `${root}/${joined}` : `${root}/`;
  return joined;
}
