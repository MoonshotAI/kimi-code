import type { GitlabRef } from './source';

export interface GitlabSourceInput {
  readonly kind: 'gitlab';
  readonly baseUrl: string;
  readonly projectPath: string;
  readonly ref?: GitlabRef;
}

export interface GitlabSourceResolution {
  readonly tarballUrl: string;
}

export async function resolveGitlabSource(
  input: GitlabSourceInput,
): Promise<GitlabSourceResolution> {
  if (input.ref !== undefined) {
    return { tarballUrl: archiveUrl(input, input.ref) };
  }

  const latestTag = await tryResolveLatestReleaseTag(input);
  return {
    tarballUrl:
      latestTag === undefined
        ? archiveUrl(input)
        : archiveUrl(input, { kind: 'tag', value: latestTag }),
  };
}

async function tryResolveLatestReleaseTag(
  input: GitlabSourceInput,
): Promise<string | undefined> {
  const projectId = encodeURIComponent(input.projectPath);
  const url = `${input.baseUrl}/api/v4/projects/${projectId}/releases/permalink/latest`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (resp.status === 404) return undefined;
  if (!resp.ok) {
    throw new Error(
      `Could not look up latest release of \`${input.projectPath}\` on ${input.baseUrl}: ` +
        `HTTP ${resp.status} ${resp.statusText}.`,
    );
  }

  const release = (await resp.json()) as { tag_name?: unknown };
  if (typeof release.tag_name !== 'string' || release.tag_name.length === 0) {
    throw new Error(
      `Could not determine the latest release tag of \`${input.projectPath}\` on ${input.baseUrl}.`,
    );
  }
  return release.tag_name;
}

function archiveUrl(input: GitlabSourceInput, ref?: GitlabRef): string {
  const projectId = encodeURIComponent(input.projectPath);
  const url = new URL(
    `${input.baseUrl}/api/v4/projects/${projectId}/repository/archive.zip`,
  );
  if (ref !== undefined) {
    url.searchParams.set('sha', ref.value);
    if (ref.kind === 'tag') url.searchParams.set('ref_type', 'tags');
  }
  return url.toString();
}
