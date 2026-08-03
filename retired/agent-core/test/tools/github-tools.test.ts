import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { ExecutableToolContext } from '../../src/loop/types';

// Mock the native bridge so no real HTTP/native module is exercised. The GitHub
// tools only depend on `tryNativeGithubRequest` from this module.
vi.mock('../../src/tools/builtin/native-tools', () => ({
  tryNativeGithubRequest: vi.fn(),
}));

import { tryNativeGithubRequest } from '../../src/tools/builtin/native-tools';
import {
  createGitHubTools,
  GITHUB_READONLY_TOOL_NAMES,
} from '../../src/tools/builtin/github/github-tools';

const mockReq = vi.mocked(tryNativeGithubRequest);

const ctx: ExecutableToolContext = {
  turnId: 'turn',
  toolCallId: 'call',
  signal: new AbortController().signal,
};

function toolByName(name: string) {
  const found = createGitHubTools().find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not registered`);
  return found;
}

async function run(name: string, args: unknown) {
  const exec = await toolByName(name).resolveExecution(args);
  if (!('execute' in exec)) return exec; // arg-validation error path
  return exec.execute(ctx);
}

describe('github tools', () => {
  beforeEach(() => {
    mockReq.mockReset();
    mockReq.mockResolvedValue({ status: 200, ok: true, body: '{}' });
  });

  it('registers a comprehensive, unique tool set', () => {
    const tools = createGitHubTools();
    expect(tools.length).toBeGreaterThanOrEqual(28);
    const names = new Set(tools.map((t) => t.name));
    expect(names.size).toBe(tools.length);
    for (const t of tools) {
      expect(typeof t.description).toBe('string');
      expect(t.parameters).toBeTypeOf('object');
    }
  });

  it('GitHubGetIssue → GET /repos/{owner}/{repo}/issues/{n}', async () => {
    await run('GitHubGetIssue', { owner: 'o', repo: 'r', issueNumber: 5 });
    expect(mockReq).toHaveBeenCalledWith('GET', '/repos/o/r/issues/5', expect.any(Object));
  });

  it('GitHubListIssues forwards query params', async () => {
    await run('GitHubListIssues', { owner: 'o', repo: 'r', state: 'open', perPage: 50 });
    const [method, path, options] = mockReq.mock.calls[0];
    expect(method).toBe('GET');
    expect(path).toBe('/repos/o/r/issues');
    expect(options?.query).toMatchObject({ state: 'open', per_page: 50 });
  });

  it('GitHubCreateIssue sends a POST body', async () => {
    await run('GitHubCreateIssue', { owner: 'o', repo: 'r', title: 'Hi', body: 'B' });
    const [method, path, options] = mockReq.mock.calls[0];
    expect(method).toBe('POST');
    expect(path).toBe('/repos/o/r/issues');
    expect(options?.body).toMatchObject({ title: 'Hi', body: 'B' });
  });

  it('GitHubCreateOrUpdateFile base64-encodes content', async () => {
    await run('GitHubCreateOrUpdateFile', {
      owner: 'o',
      repo: 'r',
      path: 'a/b.txt',
      message: 'm',
      content: 'hello world',
    });
    const options = mockReq.mock.calls[0][2];
    expect((options?.body as { content: string }).content).toBe(
      Buffer.from('hello world', 'utf8').toString('base64'),
    );
  });

  it('GitHubGetPRDiff requests the diff media type', async () => {
    mockReq.mockResolvedValue({ status: 200, ok: true, body: 'diff --git ...' });
    await run('GitHubGetPRDiff', { owner: 'o', repo: 'r', pullNumber: 3 });
    expect(mockReq.mock.calls[0][2]?.accept).toBe('application/vnd.github.diff');
  });

  it('surfaces a missing-token error to the model', async () => {
    mockReq.mockResolvedValue({
      status: 0,
      ok: false,
      body: '',
      error: 'No GitHub token found. Set the GITHUB_TOKEN (or GH_TOKEN) environment variable.',
    });
    const res = await run('GitHubGetMe', {});
    expect(res.isError).toBe(true);
    expect(String(res.output)).toContain('GITHUB_TOKEN');
  });

  it('rejects invalid arguments before calling the API', async () => {
    const res = await run('GitHubGetIssue', { owner: 'o' }); // missing repo + issueNumber
    expect(res.isError).toBe(true);
    expect(mockReq).not.toHaveBeenCalled();
  });

  it('read-only allowlist includes reads and excludes mutations', () => {
    expect(GITHUB_READONLY_TOOL_NAMES).toContain('GitHubGetIssue');
    expect(GITHUB_READONLY_TOOL_NAMES).toContain('GitHubGetPRDiff');
    expect(GITHUB_READONLY_TOOL_NAMES).not.toContain('GitHubCreateIssue');
    expect(GITHUB_READONLY_TOOL_NAMES).not.toContain('GitHubMergePR');
    expect(GITHUB_READONLY_TOOL_NAMES).not.toContain('GitHubCreateOrUpdateFile');
  });
});
