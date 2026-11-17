export function decodeMcpToolName(
  name: string,
): { readonly serverName: string; readonly toolName: string } | null {
  const PREFIX = 'mcp__';
  if (!name.startsWith(PREFIX)) return null;
  const rest = name.slice(PREFIX.length);
  const sep = rest.indexOf('__');
  if (sep <= 0 || sep === rest.length - 2) return null;
  return {
    serverName: rest.slice(0, sep),
    toolName: rest.slice(sep + 2),
  };
}
