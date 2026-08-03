import type { GithubRef } from './source';
import type { PluginGithubRef } from './types';

export interface GithubSourceInput {
  readonly kind: 'github';
  readonly owner: string;
  readonly repo: string;
  readonly ref?: GithubRef;
}

export interface GithubSourceResolution {
  readonly tarballUrl: string;
  readonly displayVersion: string;
  readonly ref: PluginGithubRef;
}

/**
 * Resolve a `github` source descriptor to a downloadable zip URL.
 *
 * Hot path is the bare-URL case (no explicit ref). We deliberately avoid
 * `api.github.com` because its anonymous quota (60/hour per egress IP) is
 * shared with the user's browser, gh CLI, IDE integrations, etc., and
 * first-time install failing because some other tool burned the budget is
 * unacceptable for our UX.
 *
 * Strategy:
 *   1. Explicit ref → straight to codeload, zero network calls beforehand.
 *   2. Bare URL:
 *      a. GET `github.com/{owner}/{repo}/releases/latest` with manual
 *         redirect. 302 → extract tag from `Location` header. This is a
 *         documented-by-behavior GitHub UI route used by Homebrew, gh, etc.
 *         It is *not* part of the API quota.
 *      b. 404 or 302 to `/releases` (fork without own releases) → fall back
 *         to `codeload.github.com/{o}/{r}/zip/HEAD`, which streams the
 *         default branch tip without us needing to know its name.
 *      c. codeload 404 on HEAD → the repo itself does not exist.
 */
export async function resolveGithubSource(
  input: GithubSourceInput,
): Promise<GithubSourceResolution> {
  const { owner, repo } = input;

  if (input.ref !== undefined) {
    return {
      tarballUrl: codeloadUrl(owner, repo, input.ref),
      displayVersion: input.ref.value,
      ref: { kind: input.ref.kind, value: input.ref.value },
    };
  }

  const latestTag = await tryResolveLatestReleaseTag(owner, repo);
  if (latestTag !== undefined) {
    return {
      tarballUrl: codeloadUrl(owner, repo, { kind: 'tag', value: latestTag }),
      displayVersion: latestTag,
      ref: { kind: 'tag', value: latestTag },
    };
  }

  // No release we could resolve. Fall back to the default branch via codeload.
  const headProbe = await fetch(
    `https://codeload.github.com/${owner}/${repo}/zip/HEAD`,
    { method: 'HEAD' },
  );
  if (headProbe.status === 404) {
    throw new Error(`Repository \`${owner}/${repo}\` not found or not accessible.`);
  }
  if (!headProbe.ok) {
    throw new Error(
      `Could not access \`${owner}/${repo}\`: HTTP ${headProbe.status} ${headProbe.statusText}.`,
    );
  }
  return {
    tarballUrl: `https://codeload.github.com/${owner}/${repo}/zip/HEAD`,
    displayVersion: 'HEAD',
    ref: { kind: 'branch', value: 'HEAD' },
  };
}

/**
 * Returns:
 *   - tag string  → a real latest release was advertised
 *   - undefined   → the repo definitively has no own latest release;
 *                   caller should fall back to the default branch
 *
 * Throws on any unexpected HTTP status (5xx, 403, 429, ...). We deliberately
 * do *not* fold those into "no release" — silently installing the default
 * branch on a transient GitHub error is worse than failing loudly: the user
 * would end up with content different from what they asked for and we would
 * not tell them.
 */
async function tryResolveLatestReleaseTag(
  owner: string,
  repo: string,
): Promise<string | undefined> {
  const url = `https://github.com/${owner}/${repo}/releases/latest`;
  const resp = await fetch(url, { redirect: 'manual' });

  // Definitive "no own latest release". Distinct from transient errors.
  if (resp.status === 404) return undefined;

  if (resp.status !== 301 && resp.status !== 302) {
    throw new Error(
      `Could not look up latest release of \`${owner}/${repo}\`: ` +
        `HTTP ${resp.status} ${resp.statusText} (${url}). ` +
        `Pin a specific ref with \`/tree/<branch|tag|sha>\` to bypass release lookup.`,
    );
  }

  const location = resp.headers.get('location');
  if (location === null) return undefined;

  // Forks without their own releases redirect to bare `/releases` (the page
  // that lists tags inherited from upstream) instead of a specific tag URL.
  // Treat that as "no own latest release" and fall back to the default branch.
  const match = /\/releases\/tag\/([^/?#]+)/.exec(location);
  if (match === null) return undefined;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return match[1];
  }
}

function codeloadUrl(owner: string, repo: string, ref: GithubRef): string {
  const base = `https://codeload.github.com/${owner}/${repo}/zip`;
  const encoded = encodeCodeloadRefPath(ref.value);
  if (ref.kind === 'sha') return `${base}/${encoded}`;
  // For a ref we confirmed is a tag (came from /releases/tag/...), use the
  // explicit refs/tags/ path so the download is unambiguous even if a branch
  // with the same name exists in the repo.
  if (ref.kind === 'tag') return `${base}/refs/tags/${encoded}`;
  // For a `branch`-kind ref we cannot tell whether the user-typed value names
  // a branch or a tag (e.g. `/tree/v5.1.0`). Use codeload's short form to let
  // the GitHub backend resolve it the same way `github.com/.../tree/<x>` does.
  return `${base}/${encoded}`;
}

/**
 * Percent-encode a ref name for safe interpolation into a codeload URL path.
 *
 * Git permits characters in ref names that have special meaning in URLs.
 * The reviewer-flagged case is `#`: a valid Git tag character (e.g. a release
 * named `release#1`) but a URL fragment delimiter. Pasted naively into
 * `…/refs/tags/release#1`, the `#1` is parsed as a fragment and the HTTP
 * request reaches the server as `…/refs/tags/release` — which 404s, or worse,
 * delivers a different ref.
 *
 * Refs may also legitimately contain `/` (a branch named `feat/foo`, or a
 * tag named `series/v1`). We must preserve those as real path separators.
 * So: split on `/`, percent-encode each segment, and rejoin.
 */
function encodeCodeloadRefPath(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/');
}
