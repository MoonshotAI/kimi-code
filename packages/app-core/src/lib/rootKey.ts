
const WIN_SHAPED = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/;

export function workspaceRootKey(root: string): string {
  const slashed = root.replaceAll('\\', '/');
  const shaped = WIN_SHAPED.test(slashed);
  const normalized = slashed.replace(/\/+$/, '');
  return shaped ? normalized.toLowerCase() : normalized;
}
