import path from 'node:path';

export interface GithubRef {
  readonly kind: 'branch' | 'tag' | 'sha';
  readonly value: string;
}

export type GitlabRef = GithubRef;

export type ResolvedSource =
  | { kind: 'local-path'; path: string }
  | { kind: 'zip-url'; path: string }
  | { kind: 'github'; owner: string; repo: string; ref?: GithubRef }
  | { kind: 'gitlab'; baseUrl: string; projectPath: string; ref?: GitlabRef };

export type InstallSource = ResolvedSource;

const SHA_RE = /^[0-9a-f]{7,40}$/;

export function resolveInstallSource(source: string): ResolvedSource {
  const trimmed = source.trim();

  const github = parseGithubUrl(trimmed);
  if (github !== undefined) return github;

  const gitlab = parseGitlabUrl(trimmed);
  if (gitlab !== undefined) return gitlab;

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return { kind: 'zip-url', path: trimmed };
  }
  if (!path.isAbsolute(trimmed)) {
    throw new Error(`Plugin root must be an absolute path (got "${source}")`);
  }
  return { kind: 'local-path', path: trimmed };
}

function parseGitlabUrl(raw: string): ResolvedSource | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;

  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  const separatorIndex = segments.indexOf('-');
  const projectSegments = separatorIndex === -1 ? segments : segments.slice(0, separatorIndex);
  const rest = separatorIndex === -1 ? [] : segments.slice(separatorIndex + 1);
  const repoRaw = projectSegments.at(-1);
  if (projectSegments.length < 2 || repoRaw === undefined) return undefined;

  const hasGitSuffix = repoRaw.endsWith('.git');
  const isGitlabHost = url.hostname.toLowerCase().split('.').includes('gitlab');
  if (!isGitlabHost && separatorIndex === -1 && !hasGitSuffix) return undefined;
  if (separatorIndex === -1 && (segments[0] === 'api' || repoRaw.endsWith('.zip'))) {
    return undefined;
  }

  const repo = hasGitSuffix ? repoRaw.slice(0, -4) : repoRaw;
  const projectPath = decodeRefSegments([...projectSegments.slice(0, -1), repo]);
  const base = { kind: 'gitlab' as const, baseUrl: url.origin, projectPath };

  if (rest.length === 0) return base;

  const head = rest[0];
  if (head === 'tree' && rest.length >= 2) {
    const value = decodeRefSegments(rest.slice(1));
    const kind: GitlabRef['kind'] = SHA_RE.test(value) ? 'sha' : 'branch';
    return { ...base, ref: { kind, value } };
  }

  if (head === 'releases' && rest.length >= 2) {
    if (rest[1] === 'permalink' && rest[2] === 'latest') return base;
    return {
      ...base,
      ref: { kind: 'tag', value: decodeRefSegments(rest.slice(1)) },
    };
  }

  if (head === 'commit' && rest.length >= 2) {
    return {
      ...base,
      ref: { kind: 'sha', value: decodeRefSegments(rest.slice(1)) },
    };
  }

  return undefined;
}

function parseGithubUrl(raw: string): ResolvedSource | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return undefined;

  const segments = url.pathname.split('/').filter((s) => s.length > 0);
  const owner = segments[0];
  const repoRaw = segments[1];
  if (owner === undefined || repoRaw === undefined) return undefined;

  const repo = repoRaw.endsWith('.git') ? repoRaw.slice(0, -4) : repoRaw;
  const rest = segments.slice(2);

  if (rest.length === 0) {
    return { kind: 'github', owner, repo };
  }

  const head = rest[0];
  const second = rest[1];

  if (head === 'tree' && rest.length >= 2) {
    const refValue = decodeRefSegments(rest.slice(1));
    const kind: GithubRef['kind'] = SHA_RE.test(refValue) ? 'sha' : 'branch';
    return { kind: 'github', owner, repo, ref: { kind, value: refValue } };
  }

  if (head === 'releases' && second === 'tag' && rest.length >= 3) {
    const tag = decodeRefSegments(rest.slice(2));
    return { kind: 'github', owner, repo, ref: { kind: 'tag', value: tag } };
  }

  if (head === 'commit' && rest.length >= 2) {
    const sha = decodeRefSegments(rest.slice(1));
    return { kind: 'github', owner, repo, ref: { kind: 'sha', value: sha } };
  }

  return undefined;
}

function decodeRefSegments(segments: readonly string[]): string {
  return segments
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join('/');
}
