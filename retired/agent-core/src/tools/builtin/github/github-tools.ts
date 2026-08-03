/**
 * Built-in GitHub tools — thin, table-driven definitions over the native Rust
 * GitHub transport (`nativeGithubRequest`). Rust owns auth/headers/TLS/
 * pagination; each entry here declares an LLM-facing tool: zod schema →
 * JSON-schema, the endpoint (method + path + query/body builders), and how to
 * format the response. Adding a tool = appending one `makeGitHubTool(...)`.
 *
 * Auth comes from `GITHUB_TOKEN` / `GH_TOKEN` (resolved in Rust); when unset,
 * the tool returns a helpful error at call time. Registration is gated by the
 * `github_tools` experimental flag.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import { literalRulePattern, matchesGlobRuleSubject } from '../../support/rule-match';
import { ToolResultBuilder } from '../../support/result-builder';
import { tryNativeGithubRequest, type NativeGithubRequestOptions } from '../native-tools';

// ── Reusable schema fragments ────────────────────────────────────────────────

const owner = z.string().min(1).describe('Repository owner (user or organization login).');
const repo = z.string().min(1).describe('Repository name.');
const perPage = z.number().int().min(1).max(100).optional().describe('Results per page (1–100).');
const page = z.number().int().min(1).optional().describe('Page number (1-based).');

// ── Tool factory ─────────────────────────────────────────────────────────────

interface GitHubToolSpec<S extends z.ZodTypeAny> {
  readonly name: string;
  readonly description: string;
  readonly schema: S;
  readonly method: string;
  readonly path: (args: z.infer<S>) => string;
  readonly query?: (args: z.infer<S>) => Record<string, unknown>;
  readonly body?: (args: z.infer<S>) => unknown;
  readonly paginate?: boolean;
  readonly accept?: string;
  /** Mutating tools are omitted from the auto-approve allowlist (they prompt). */
  readonly mutating?: boolean;
  /** Rule subject used for approval matching (e.g. "owner/repo"). */
  readonly subject: (args: z.infer<S>) => string;
}

function makeGitHubTool<S extends z.ZodTypeAny>(spec: GitHubToolSpec<S>): BuiltinTool {
  const parameters = toInputJsonSchema(spec.schema);
  return {
    name: spec.name,
    description: spec.description,
    parameters,
    resolveExecution(rawArgs: unknown): ToolExecution {
      const parsed = spec.schema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          isError: true,
          output: `Invalid arguments for ${spec.name}: ${parsed.error.message}`,
        };
      }
      const args = parsed.data;
      const subject = spec.subject(args);
      return {
        accesses: ToolAccesses.none(),
        description: spec.name,
        approvalRule: literalRulePattern(spec.name, subject),
        matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, subject),
        execute: async (): Promise<ExecutableToolResult> => {
          const options: NativeGithubRequestOptions = {};
          const query = spec.query?.(args);
          if (query !== undefined) options.query = query;
          if (spec.body !== undefined) options.body = spec.body(args);
          if (spec.paginate !== undefined) options.paginate = spec.paginate;
          if (spec.accept !== undefined) options.accept = spec.accept;

          const res = await tryNativeGithubRequest(spec.method, spec.path(args), options);
          if (!res) {
            return {
              isError: true,
              output:
                'GitHub support is unavailable: the native module failed to load. Rebuild @moonshot-ai/kimi-native-tools.',
            };
          }
          if (!res.ok) {
            const detail = res.body ? `\n${res.body.slice(0, 4000)}` : '';
            const status = res.status > 0 ? ` (status ${String(res.status)})` : '';
            return {
              isError: true,
              output: `${res.error ?? 'GitHub request failed'}${status}${detail}`,
            };
          }
          const builder = new ToolResultBuilder({ maxLineLength: null });
          const rate =
            typeof res.rateRemaining === 'number'
              ? `\n\n(GitHub rate limit remaining: ${String(res.rateRemaining)})`
              : '';
          builder.write((res.body || '(empty response)') + rate);
          return builder.ok();
        },
      };
    },
  };
}

const repoBase = (a: { owner: string; repo: string }): string => `${a.owner}/${a.repo}`;

// ── Tool specs ───────────────────────────────────────────────────────────────

function githubToolSpecs(): BuiltinTool[] {
  return [
    // ── Repositories ──────────────────────────────────────────────────────
    makeGitHubTool({
      name: 'GitHubGetRepo',
      description: 'Get metadata for a repository (description, default branch, stars, visibility).',
      schema: z.object({ owner, repo }),
      method: 'GET',
      path: (a) => `/repos/${a.owner}/${a.repo}`,
      subject: repoBase,
    }),
    makeGitHubTool({
      name: 'GitHubListBranches',
      description: 'List branches in a repository.',
      schema: z.object({ owner, repo, perPage, page }),
      method: 'GET',
      path: (a) => `/repos/${a.owner}/${a.repo}/branches`,
      query: (a) => ({ per_page: a.perPage, page: a.page }),
      subject: repoBase,
    }),
    makeGitHubTool({
      name: 'GitHubListCommits',
      description: 'List commits on a repository, optionally filtered by branch/sha or path.',
      schema: z.object({
        owner,
        repo,
        sha: z.string().optional().describe('Branch name or commit SHA to start from.'),
        path: z.string().optional().describe('Only commits touching this file path.'),
        perPage,
        page,
      }),
      method: 'GET',
      path: (a) => `/repos/${a.owner}/${a.repo}/commits`,
      query: (a) => ({ sha: a.sha, path: a.path, per_page: a.perPage, page: a.page }),
      subject: repoBase,
    }),
    makeGitHubTool({
      name: 'GitHubGetCommit',
      description: 'Get a single commit, including its diff stats and changed files.',
      schema: z.object({ owner, repo, ref: z.string().min(1).describe('Commit SHA, branch, or tag.') }),
      method: 'GET',
      path: (a) => `/repos/${a.owner}/${a.repo}/commits/${a.ref}`,
      subject: repoBase,
    }),
    makeGitHubTool({
      name: 'GitHubGetFileContents',
      description:
        'Get a file or directory listing. File content is returned base64-encoded in the `content` field.',
      schema: z.object({
        owner,
        repo,
        path: z.string().min(1).describe('Path to the file or directory in the repo.'),
        ref: z.string().optional().describe('Branch, tag, or commit SHA (defaults to the default branch).'),
      }),
      method: 'GET',
      path: (a) => `/repos/${a.owner}/${a.repo}/contents/${a.path}`,
      query: (a) => ({ ref: a.ref }),
      subject: repoBase,
    }),
    makeGitHubTool({
      name: 'GitHubCreateOrUpdateFile',
      description:
        'Create or update a file. Provide plain-text `content` (encoded to base64 automatically). Pass `sha` when updating an existing file.',
      schema: z.object({
        owner,
        repo,
        path: z.string().min(1).describe('Path to the file in the repo.'),
        message: z.string().min(1).describe('Commit message.'),
        content: z.string().describe('Plain (UTF-8) file content.'),
        branch: z.string().optional().describe('Target branch (defaults to the default branch).'),
        sha: z.string().optional().describe('Blob SHA of the file being replaced (required when updating).'),
      }),
      method: 'PUT',
      path: (a) => `/repos/${a.owner}/${a.repo}/contents/${a.path}`,
      body: (a) => ({
        message: a.message,
        content: Buffer.from(a.content, 'utf8').toString('base64'),
        branch: a.branch,
        sha: a.sha,
      }),
      mutating: true,
      subject: repoBase,
    }),

    // ── Issues ────────────────────────────────────────────────────────────
    makeGitHubTool({
      name: 'GitHubListIssues',
      description: 'List issues in a repository (excludes pull requests unless combined with search).',
      schema: z.object({
        owner,
        repo,
        state: z.enum(['open', 'closed', 'all']).optional().describe('Issue state filter.'),
        labels: z.string().optional().describe('Comma-separated label names.'),
        perPage,
        page,
      }),
      method: 'GET',
      path: (a) => `/repos/${a.owner}/${a.repo}/issues`,
      query: (a) => ({ state: a.state, labels: a.labels, per_page: a.perPage, page: a.page }),
      subject: repoBase,
    }),
    makeGitHubTool({
      name: 'GitHubGetIssue',
      description: 'Get a single issue by number.',
      schema: z.object({ owner, repo, issueNumber: z.number().int().describe('Issue number.') }),
      method: 'GET',
      path: (a) => `/repos/${a.owner}/${a.repo}/issues/${String(a.issueNumber)}`,
      subject: repoBase,
    }),
    makeGitHubTool({
      name: 'GitHubCreateIssue',
      description: 'Create a new issue.',
      schema: z.object({
        owner,
        repo,
        title: z.string().min(1).describe('Issue title.'),
        body: z.string().optional().describe('Issue body (Markdown).'),
        labels: z.array(z.string()).optional().describe('Label names to apply.'),
        assignees: z.array(z.string()).optional().describe('User logins to assign.'),
      }),
      method: 'POST',
      path: (a) => `/repos/${a.owner}/${a.repo}/issues`,
      body: (a) => ({ title: a.title, body: a.body, labels: a.labels, assignees: a.assignees }),
      mutating: true,
      subject: repoBase,
    }),
    makeGitHubTool({
      name: 'GitHubUpdateIssue',
      description: 'Update an issue (title, body, state, labels, assignees).',
      schema: z.object({
        owner,
        repo,
        issueNumber: z.number().int().describe('Issue number.'),
        title: z.string().optional(),
        body: z.string().optional(),
        state: z.enum(['open', 'closed']).optional(),
        labels: z.array(z.string()).optional(),
        assignees: z.array(z.string()).optional(),
      }),
      method: 'PATCH',
      path: (a) => `/repos/${a.owner}/${a.repo}/issues/${String(a.issueNumber)}`,
      body: (a) => ({
        title: a.title,
        body: a.body,
        state: a.state,
        labels: a.labels,
        assignees: a.assignees,
      }),
      mutating: true,
      subject: repoBase,
    }),
    makeGitHubTool({
      name: 'GitHubAddIssueComment',
      description: 'Add a comment to an issue or pull request.',
      schema: z.object({
        owner,
        repo,
        issueNumber: z.number().int().describe('Issue or PR number.'),
        body: z.string().min(1).describe('Comment body (Markdown).'),
      }),
      method: 'POST',
      path: (a) => `/repos/${a.owner}/${a.repo}/issues/${String(a.issueNumber)}/comments`,
      body: (a) => ({ body: a.body }),
      mutating: true,
      subject: repoBase,
    }),
    makeGitHubTool({
      name: 'GitHubListIssueComments',
      description: 'List comments on an issue or pull request.',
      schema: z.object({ owner, repo, issueNumber: z.number().int().describe('Issue or PR number.'), perPage, page }),
      method: 'GET',
      path: (a) => `/repos/${a.owner}/${a.repo}/issues/${String(a.issueNumber)}/comments`,
      query: (a) => ({ per_page: a.perPage, page: a.page }),
      subject: repoBase,
    }),

    // ── Pull requests ───────────────────────────────────────────────────────
    makeGitHubTool({
      name: 'GitHubListPRs',
      description: 'List pull requests in a repository.',
      schema: z.object({
        owner,
        repo,
        state: z.enum(['open', 'closed', 'all']).optional(),
        head: z.string().optional().describe('Filter by head branch (user:ref).'),
        base: z.string().optional().describe('Filter by base branch name.'),
        perPage,
        page,
      }),
      method: 'GET',
      path: (a) => `/repos/${a.owner}/${a.repo}/pulls`,
      query: (a) => ({ state: a.state, head: a.head, base: a.base, per_page: a.perPage, page: a.page }),
      subject: repoBase,
    }),
    makeGitHubTool({
      name: 'GitHubGetPR',
      description: 'Get a single pull request by number.',
      schema: z.object({ owner, repo, pullNumber: z.number().int().describe('Pull request number.') }),
      method: 'GET',
      path: (a) => `/repos/${a.owner}/${a.repo}/pulls/${String(a.pullNumber)}`,
      subject: repoBase,
    }),
    makeGitHubTool({
      name: 'GitHubGetPRDiff',
      description: 'Get the unified diff for a pull request.',
      schema: z.object({ owner, repo, pullNumber: z.number().int().describe('Pull request number.') }),
      method: 'GET',
      path: (a) => `/repos/${a.owner}/${a.repo}/pulls/${String(a.pullNumber)}`,
      accept: 'application/vnd.github.diff',
      subject: repoBase,
    }),
    makeGitHubTool({
      name: 'GitHubGetPRFiles',
      description: 'List the files changed in a pull request.',
      schema: z.object({ owner, repo, pullNumber: z.number().int().describe('Pull request number.'), perPage, page }),
      method: 'GET',
      path: (a) => `/repos/${a.owner}/${a.repo}/pulls/${String(a.pullNumber)}/files`,
      query: (a) => ({ per_page: a.perPage, page: a.page }),
      subject: repoBase,
    }),
    makeGitHubTool({
      name: 'GitHubCreatePR',
      description: 'Open a new pull request.',
      schema: z.object({
        owner,
        repo,
        title: z.string().min(1).describe('PR title.'),
        head: z.string().min(1).describe('Source branch (or user:branch for cross-repo).'),
        base: z.string().min(1).describe('Target branch to merge into.'),
        body: z.string().optional().describe('PR description (Markdown).'),
        draft: z.boolean().optional().describe('Open as a draft PR.'),
      }),
      method: 'POST',
      path: (a) => `/repos/${a.owner}/${a.repo}/pulls`,
      body: (a) => ({ title: a.title, head: a.head, base: a.base, body: a.body, draft: a.draft }),
      mutating: true,
      subject: repoBase,
    }),
    makeGitHubTool({
      name: 'GitHubUpdatePR',
      description: 'Update a pull request (title, body, state, base branch).',
      schema: z.object({
        owner,
        repo,
        pullNumber: z.number().int().describe('Pull request number.'),
        title: z.string().optional(),
        body: z.string().optional(),
        state: z.enum(['open', 'closed']).optional(),
        base: z.string().optional().describe('New base branch.'),
      }),
      method: 'PATCH',
      path: (a) => `/repos/${a.owner}/${a.repo}/pulls/${String(a.pullNumber)}`,
      body: (a) => ({ title: a.title, body: a.body, state: a.state, base: a.base }),
      mutating: true,
      subject: repoBase,
    }),
    makeGitHubTool({
      name: 'GitHubMergePR',
      description: 'Merge a pull request.',
      schema: z.object({
        owner,
        repo,
        pullNumber: z.number().int().describe('Pull request number.'),
        commitTitle: z.string().optional().describe('Title for the merge commit.'),
        mergeMethod: z.enum(['merge', 'squash', 'rebase']).optional().describe('Merge strategy.'),
      }),
      method: 'PUT',
      path: (a) => `/repos/${a.owner}/${a.repo}/pulls/${String(a.pullNumber)}/merge`,
      body: (a) => ({ commit_title: a.commitTitle, merge_method: a.mergeMethod }),
      mutating: true,
      subject: repoBase,
    }),
    makeGitHubTool({
      name: 'GitHubCreatePRReview',
      description: 'Submit a review on a pull request (APPROVE, REQUEST_CHANGES, or COMMENT).',
      schema: z.object({
        owner,
        repo,
        pullNumber: z.number().int().describe('Pull request number.'),
        event: z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']).describe('Review action.'),
        body: z.string().optional().describe('Review summary comment.'),
      }),
      method: 'POST',
      path: (a) => `/repos/${a.owner}/${a.repo}/pulls/${String(a.pullNumber)}/reviews`,
      body: (a) => ({ event: a.event, body: a.body }),
      mutating: true,
      subject: repoBase,
    }),
    makeGitHubTool({
      name: 'GitHubListPRReviewComments',
      description: 'List review comments (inline code comments) on a pull request.',
      schema: z.object({ owner, repo, pullNumber: z.number().int().describe('Pull request number.'), perPage, page }),
      method: 'GET',
      path: (a) => `/repos/${a.owner}/${a.repo}/pulls/${String(a.pullNumber)}/comments`,
      query: (a) => ({ per_page: a.perPage, page: a.page }),
      subject: repoBase,
    }),

    // ── Search ────────────────────────────────────────────────────────────
    makeGitHubTool({
      name: 'GitHubSearchCode',
      description: 'Search code across GitHub. Use qualifiers like `repo:owner/name`, `path:`, `language:`.',
      schema: z.object({ q: z.string().min(1).describe('Search query.'), perPage, page }),
      method: 'GET',
      path: () => '/search/code',
      query: (a) => ({ q: a.q, per_page: a.perPage, page: a.page }),
      subject: (a) => a.q,
    }),
    makeGitHubTool({
      name: 'GitHubSearchRepos',
      description: 'Search repositories. Supports qualifiers like `language:`, `stars:>100`, `user:`.',
      schema: z.object({
        q: z.string().min(1).describe('Search query.'),
        sort: z.enum(['stars', 'forks', 'updated']).optional(),
        perPage,
        page,
      }),
      method: 'GET',
      path: () => '/search/repositories',
      query: (a) => ({ q: a.q, sort: a.sort, per_page: a.perPage, page: a.page }),
      subject: (a) => a.q,
    }),
    makeGitHubTool({
      name: 'GitHubSearchIssues',
      description: 'Search issues and pull requests. Supports qualifiers like `repo:`, `is:pr`, `author:`, `state:`.',
      schema: z.object({
        q: z.string().min(1).describe('Search query.'),
        sort: z.enum(['comments', 'created', 'updated']).optional(),
        perPage,
        page,
      }),
      method: 'GET',
      path: () => '/search/issues',
      query: (a) => ({ q: a.q, sort: a.sort, per_page: a.perPage, page: a.page }),
      subject: (a) => a.q,
    }),

    // ── Actions (read-only) ───────────────────────────────────────────────
    makeGitHubTool({
      name: 'GitHubListWorkflowRuns',
      description: 'List GitHub Actions workflow runs for a repository.',
      schema: z.object({
        owner,
        repo,
        branch: z.string().optional().describe('Filter by branch.'),
        status: z.string().optional().describe('Filter by status/conclusion (e.g. success, failure, in_progress).'),
        perPage,
        page,
      }),
      method: 'GET',
      path: (a) => `/repos/${a.owner}/${a.repo}/actions/runs`,
      query: (a) => ({ branch: a.branch, status: a.status, per_page: a.perPage, page: a.page }),
      subject: repoBase,
    }),
    makeGitHubTool({
      name: 'GitHubGetWorkflowRun',
      description: 'Get a single GitHub Actions workflow run.',
      schema: z.object({ owner, repo, runId: z.number().int().describe('Workflow run id.') }),
      method: 'GET',
      path: (a) => `/repos/${a.owner}/${a.repo}/actions/runs/${String(a.runId)}`,
      subject: repoBase,
    }),

    // ── Releases ──────────────────────────────────────────────────────────
    makeGitHubTool({
      name: 'GitHubListReleases',
      description: 'List releases for a repository.',
      schema: z.object({ owner, repo, perPage, page }),
      method: 'GET',
      path: (a) => `/repos/${a.owner}/${a.repo}/releases`,
      query: (a) => ({ per_page: a.perPage, page: a.page }),
      subject: repoBase,
    }),
    makeGitHubTool({
      name: 'GitHubGetLatestRelease',
      description: 'Get the latest published release for a repository.',
      schema: z.object({ owner, repo }),
      method: 'GET',
      path: (a) => `/repos/${a.owner}/${a.repo}/releases/latest`,
      subject: repoBase,
    }),

    // ── Viewer ────────────────────────────────────────────────────────────
    makeGitHubTool({
      name: 'GitHubGetMe',
      description: 'Get the authenticated user (verifies the configured token).',
      schema: z.object({}),
      method: 'GET',
      path: () => '/user',
      subject: () => 'me',
    }),
  ];
}

/**
 * Read-only GitHub tool names — added to the default auto-approve allowlist so
 * they run without a prompt (like Read/FetchURL). Mutating tools are excluded
 * and therefore prompt for approval in non-auto permission modes.
 */
export const GITHUB_READONLY_TOOL_NAMES: readonly string[] = [
  'GitHubGetRepo',
  'GitHubListBranches',
  'GitHubListCommits',
  'GitHubGetCommit',
  'GitHubGetFileContents',
  'GitHubListIssues',
  'GitHubGetIssue',
  'GitHubListIssueComments',
  'GitHubListPRs',
  'GitHubGetPR',
  'GitHubGetPRDiff',
  'GitHubGetPRFiles',
  'GitHubListPRReviewComments',
  'GitHubSearchCode',
  'GitHubSearchRepos',
  'GitHubSearchIssues',
  'GitHubListWorkflowRuns',
  'GitHubGetWorkflowRun',
  'GitHubListReleases',
  'GitHubGetLatestRelease',
  'GitHubGetMe',
];

/** Instantiate the full set of built-in GitHub tools. */
export function createGitHubTools(token?: string): BuiltinTool[] {
  // When a token is provided via config, set it as the env var so the Rust
  // native code (which reads from GITHUB_TOKEN / GH_TOKEN) can pick it up.
  // Only set it when the env var is not already set, so the env var takes
  // priority over the config value.
  if (token !== undefined && token.length > 0 && !process.env['GITHUB_TOKEN'] && !process.env['GH_TOKEN']) {
    process.env['GITHUB_TOKEN'] = token;
  }
  return githubToolSpecs();
}
