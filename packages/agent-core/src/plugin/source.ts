import path from 'node:path';

export type InstallSource =
  | { kind: 'local-path'; path: string }
  | { kind: 'zip-url'; path: string };

export interface ResolvedSource {
  readonly kind: 'local-path' | 'zip-url';
  readonly path: string;
}

export function resolveInstallSource(source: string): ResolvedSource {
  const trimmed = source.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return { kind: 'zip-url', path: trimmed };
  }
  if (!path.isAbsolute(trimmed)) {
    throw new Error(`Plugin root must be an absolute path (got "${source}")`);
  }
  return { kind: 'local-path', path: trimmed };
}
