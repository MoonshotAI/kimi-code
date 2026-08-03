import path from 'node:path';

export interface GithubRef {
  readonly kind: 'branch' | 'tag' | 'sha';
  readonly value: string;
}

export type ResolvedSource =
  | { kind: 'local-path'; path: string }
  | { kind: 'zip-url'; path: string }
  | { kind: 'github'; owner: string; repo: string; ref?: GithubRef };

// Kept as a back-compat alias for downstream code that imported the old name.
export type InstallSource = ResolvedSource;

const SHA_RE = /^[0-9a-f]{7,40}$/;

export function resolveInstallSource(source: string): ResolvedSource {
  const trimmed = source.trim();

  const github = parseGithubUrl(trimmed);
  if (github !== undefined) return github;

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return { kind: 'zip-url', path: trimmed };
  }
  if (!path.isAbsolute(trimmed)) {
    throw new Error(`Plugin root must be an absolute path (got "${source}")`);
  }
  return { kind: 'local-path', path: trimmed };
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
    // `url.pathname` preserves percent-encoding (e.g. `release%231`). Decode
    // each segment so the stored ref value is the human-readable Git ref name.
    // The resolver re-encodes when building the codeload URL.
    const refValue = decodeRefSegments(rest.slice(1));
    // We cannot tell branch from tag at parse time. For SHA-shaped values use
    // kind: 'sha'; otherwise label as 'branch'. The resolver compensates by
    // using codeload's short-form URL for 'branch' kinds, so codeload itself
    // picks branch-or-tag — matching how `/tree/<x>` resolves in the GitHub UI.
    const kind: GithubRef['kind'] = SHA_RE.test(refValue) ? 'sha' : 'branch';
    return { kind: 'github', owner, repo, ref: { kind, value: refValue } };
  }

  if (head === 'releases' && second === 'tag' && rest.length >= 3) {
    // Recognize the canonical "this is a specific release" URL form. Earlier
    // versions rejected it and pointed users at /tree/<tag>, but /tree/<tag>
    // could not be parsed as a tag (only branch), which produced a 404 when
    // codeload was asked for refs/heads/<tag-name>.
    const tag = decodeRefSegments(rest.slice(2));
    return { kind: 'github', owner, repo, ref: { kind: 'tag', value: tag } };
  }

  if (head === 'commit' && rest.length >= 2) {
    // Mirror the /releases/tag/ change for symmetry: a commit URL pinpoints a
    // SHA, so accept it directly instead of bouncing users to /tree/<sha>.
    const sha = decodeRefSegments(rest.slice(1));
    return { kind: 'github', owner, repo, ref: { kind: 'sha', value: sha } };
  }

  // /archive/refs/{heads,tags}/X.zip and any other path — fall through to zip-url.
  return undefined;
}

/**
 * Join path segments and percent-decode them into a single ref name.
 *
 * `URL.pathname` keeps `%xx` sequences as-is (e.g. `release%231`), but
 * downstream code treats the ref value as a raw Git ref. Decoding here keeps
 * one canonical representation: human-readable in storage and display, and
 * re-encoded by the resolver when it builds a codeload URL.
 *
 * Malformed percent-encoding (`%ZZ`) is tolerated: we keep the raw segments
 * so the user sees a meaningful error downstream rather than a parse crash.
 */
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
