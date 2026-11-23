export function abbreviateHome(path: string): string {
  const home = process.env['HOME'];
  if (home === undefined || home === '') return path;
  if (path === home) return '~';
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
