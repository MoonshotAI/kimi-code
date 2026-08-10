export function normalizeRemote(url: string): string {
  const trimmed = url.trim();
  if (trimmed.length === 0) return '';

  if (!trimmed.includes('://')) {
    const scpLike = /^(?:[^@\s]+@)?([^:\s]+):(.+)$/.exec(trimmed);
    if (scpLike !== null) {
      return joinRemoteParts(scpLike[1], undefined, scpLike[2]);
    }
    return stripGitSuffix(trimmed);
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname.length === 0) return stripGitSuffix(trimmed);
    return joinRemoteParts(parsed.hostname, parsed.port, parsed.pathname);
  } catch {
    return stripGitSuffix(trimmed);
  }
}

function joinRemoteParts(
  host: string | undefined,
  port: string | undefined,
  path: string | undefined,
): string {
  const normalizedHost = host?.trim() ?? '';
  const normalizedPort = port?.trim() ?? '';
  const normalizedPath = stripGitSuffix(path ?? '');
  const parts = [normalizedHost];
  if (normalizedPort.length > 0) parts.push(normalizedPort);
  if (normalizedPath.length > 0) parts.push(normalizedPath);
  return parts.join('/');
}

function stripGitSuffix(value: string): string {
  let normalized = value.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (normalized.endsWith('.git')) {
    normalized = normalized.slice(0, -4);
  }
  return normalized;
}
