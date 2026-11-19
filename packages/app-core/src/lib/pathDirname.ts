
export function pathDirname(path: string): string {
  const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (lastSlash < 0) return '';
  if (lastSlash === 0) return path[0]!;
  return path.slice(0, lastSlash);
}
