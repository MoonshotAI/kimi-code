import { describe, expect, it } from 'vitest';
import type { ChatTurn, ToolCall } from '@moonshot-ai/app-core/client/types';
import { createCwdAssumedResolver, createChatFilePathResolver } from '../src/chat/turnFilePathIndex';

function tool(id: string, arg: string, status: 'ok' | 'running' | 'error' = 'ok'): ToolCall {
  return { id, name: 'Read', arg, status };
}

function turnFromBlocks(args: string[]): ChatTurn {
  return {
    id: 't1',
    role: 'assistant',
    no: 1,
    text: '',
    blocks: args.map((arg, i) => ({ kind: 'tool' as const, tool: tool(`tool-${i}`, arg) })),
  };
}

describe('createChatFilePathResolver', () => {
  it('resolves a bare filename to the unique absolute tool path', () => {
    const turn = turnFromBlocks(['{"path":"/tmp/repro-proj-b/package.json"}']);
    const resolve = createChatFilePathResolver(turn, '/Users/me/repo-a');
    expect(resolve('package.json')).toEqual({ path: '/tmp/repro-proj-b/package.json', assumed: false });
  });

  it('resolves a multi-segment relative path by suffix', () => {
    const turn = turnFromBlocks(['{"path":"/tmp/repro-proj-b/resources/kimi/kimi-logo-light.svg"}']);
    const resolve = createChatFilePathResolver(turn, '/Users/me/repo-a');
    expect(resolve('resources/kimi/kimi-logo-light.svg')).toEqual({
      path: '/tmp/repro-proj-b/resources/kimi/kimi-logo-light.svg',
      assumed: false,
    });
  });

  it('strips a leading ./ before matching', () => {
    const turn = turnFromBlocks(['{"path":"/tmp/b/package.json"}']);
    const resolve = createChatFilePathResolver(turn, '/Users/me/repo-a');
    expect(resolve('./package.json')).toEqual({ path: '/tmp/b/package.json', assumed: false });
  });

  it('matches case-insensitively but returns the original form on a Windows cwd', () => {
    const turn = turnFromBlocks(['{"path":"C:\\\\proj\\\\b\\\\Package.JSON"}']);
    const resolve = createChatFilePathResolver(turn, 'C:\\proj\\a');
    expect(resolve('package.json')).toEqual({ path: 'C:\\proj\\b\\Package.JSON', assumed: false });
  });

  it('matches Windows absolute paths and returns the original separators', () => {
    const turn = turnFromBlocks(['{"path":"C:\\\\proj\\\\b\\\\package.json"}']);
    const resolve = createChatFilePathResolver(turn, 'C:\\proj\\a');
    expect(resolve('package.json')).toEqual({ path: 'C:\\proj\\b\\package.json', assumed: false });
  });

  it('falls back to a cwd-assumed path when nothing matches', () => {
    const turn = turnFromBlocks(['{"path":"/tmp/b/README.md"}']);
    const resolve = createChatFilePathResolver(turn, '/Users/me/repo-a');
    expect(resolve('src/index.ts')).toEqual({ path: '/Users/me/repo-a/src/index.ts', assumed: true });
  });

  it('falls back to a cwd-assumed path on ambiguous matches', () => {
    const turn = turnFromBlocks(['{"path":"/tmp/b/package.json"}', '{"path":"/tmp/c/package.json"}']);
    const resolve = createChatFilePathResolver(turn, '/Users/me/repo-a');
    expect(resolve('package.json')).toEqual({ path: '/Users/me/repo-a/package.json', assumed: true });
  });

  it('returns null when nothing matches and cwd is empty', () => {
    const turn = turnFromBlocks(['{"path":"/tmp/b/README.md"}']);
    const resolve = createChatFilePathResolver(turn, '');
    expect(resolve('src/index.ts')).toBeNull();
  });

  it('ignores relative tool arguments and non-json arguments', () => {
    const turn = turnFromBlocks(['{"path":"src/foo.ts"}', 'not json', '{"command":"ls /tmp/b"}']);
    const resolve = createChatFilePathResolver(turn, '/Users/me/repo-a');
    expect(resolve('src/foo.ts')).toEqual({ path: '/Users/me/repo-a/src/foo.ts', assumed: true });
  });

  it('returns null for paths escaping via ..', () => {
    const turn = turnFromBlocks(['{"path":"/tmp/b/package.json"}']);
    const resolve = createChatFilePathResolver(turn, '/Users/me/repo-a');
    expect(resolve('../b/package.json')).toBeNull();
  });

  it('collects paths from turn.tools when blocks are absent', () => {
    const turn: ChatTurn = { id: 't2', role: 'assistant', no: 2, text: '', tools: [tool('a', '{"path":"/tmp/b/package.json"}')] };
    const resolve = createChatFilePathResolver(turn, '/Users/me/repo-a');
    expect(resolve('package.json')).toEqual({ path: '/tmp/b/package.json', assumed: false });
  });

  it('reads alternative path fields from tool arguments', () => {
    const turn = turnFromBlocks(['{"file_path":"/tmp/b/notes.md"}']);
    const resolve = createChatFilePathResolver(turn, '/Users/me/repo-a');
    expect(resolve('notes.md')).toEqual({ path: '/tmp/b/notes.md', assumed: false });
  });

  it('excludes failed tool calls from the index', () => {
    const turn: ChatTurn = {
      id: 't3',
      role: 'assistant',
      no: 3,
      text: '',
      blocks: [
        { kind: 'tool', tool: tool('a', '{"path":"/tmp/b/package.json"}', 'error') },
        { kind: 'tool', tool: tool('b', '{"path":"/tmp/c/package.json"}') },
      ],
    };
    const resolve = createChatFilePathResolver(turn, '/Users/me/repo-a');
    expect(resolve('package.json')).toEqual({ path: '/tmp/c/package.json', assumed: false });
  });

  it('falls back to cwd when only failed tool calls mention the file', () => {
    const turn: ChatTurn = {
      id: 't4',
      role: 'assistant',
      no: 4,
      text: '',
      blocks: [{ kind: 'tool', tool: tool('a', '{"path":"/tmp/b/package.json"}', 'error') }],
    };
    const resolve = createChatFilePathResolver(turn, '/Users/me/repo-a');
    expect(resolve('package.json')).toEqual({ path: '/Users/me/repo-a/package.json', assumed: true });
  });

  it('prefers exact case over case-folded variants', () => {
    const turn = turnFromBlocks(['{"path":"/tmp/a/Foo.ts"}', '{"path":"/tmp/b/foo.ts"}']);
    const resolve = createChatFilePathResolver(turn, '/ws/a');
    expect(resolve('foo.ts')).toEqual({ path: '/tmp/b/foo.ts', assumed: false });
    expect(resolve('Foo.ts')).toEqual({ path: '/tmp/a/Foo.ts', assumed: false });
  });

  it('does not fold case on a POSIX cwd even with a single variant', () => {
    const turn = turnFromBlocks(['{"path":"/tmp/a/Foo.ts"}']);
    const resolve = createChatFilePathResolver(turn, '/ws/a');
    expect(resolve('foo.ts')).toEqual({ path: '/ws/a/foo.ts', assumed: true });
  });

  it('folds case for a single variant on a Windows cwd', () => {
    const turn = turnFromBlocks(['{"path":"C:\\\\proj\\\\Foo.ts"}']);
    const resolve = createChatFilePathResolver(turn, 'C:\\proj');
    expect(resolve('foo.ts')).toEqual({ path: 'Foo.ts', assumed: false });
  });

  it('keeps case folding on a Windows drive-root cwd', () => {
    const turn = turnFromBlocks(['{"path":"C:\\\\proj\\\\Foo.ts"}']);
    const resolve = createChatFilePathResolver(turn, 'C:\\');
    expect(resolve('foo.ts')).toEqual({ path: 'proj/Foo.ts', assumed: false });
  });

  it('dedupes candidates differing only by case on a Windows cwd', () => {
    const turn = turnFromBlocks(['{"path":"C:\\\\proj\\\\foo.ts"}', '{"path":"c:\\\\proj\\\\foo.ts"}']);
    const resolve = createChatFilePathResolver(turn, 'C:\\ws');
    const result = resolve('foo.ts');
    expect(result?.assumed).toBe(false);
    expect(result?.path.replace(/\\/g, '/').toLowerCase()).toBe('c:/proj/foo.ts');
  });

  it('returns a workspace-relative path for hits inside the cwd', () => {
    const turn = turnFromBlocks(['{"path":"/repo/src/a.ts"}']);
    const resolve = createChatFilePathResolver(turn, '/repo');
    expect(resolve('src/a.ts')).toEqual({ path: 'src/a.ts', assumed: false });
  });

  it('dedupes candidates that name the same file with different separators', () => {
    const turn = turnFromBlocks(['{"path":"C:\\\\proj\\\\foo.ts"}', '{"path":"C:/proj/foo.ts"}']);
    const resolve = createChatFilePathResolver(turn, 'C:\\ws');
    const result = resolve('foo.ts');
    expect(result?.assumed).toBe(false);
    expect(['C:\\proj\\foo.ts', 'C:/proj/foo.ts']).toContain(result?.path);
  });

  it('treats multiple case variants as ambiguous without an exact match', () => {
    const turn = turnFromBlocks(['{"path":"C:\\\\a\\\\Foo.ts"}', '{"path":"C:\\\\b\\\\foo.ts"}']);
    const resolve = createChatFilePathResolver(turn, 'C:\\ws');
    expect(resolve('FOO.ts')).toEqual({ path: 'C:\\ws/FOO.ts', assumed: true });
  });

  it('keeps a POSIX root cwd usable', () => {
    const resolve = createChatFilePathResolver(turnFromBlocks([]), '/');
    expect(resolve('etc/hosts')).toEqual({ path: '/etc/hosts', assumed: true });
  });

  it('joins a Windows drive-root cwd without dropping the drive', () => {
    const resolve = createChatFilePathResolver(turnFromBlocks([]), 'C:\\');
    expect(resolve('proj/x.ts')).toEqual({ path: 'C:/proj/x.ts', assumed: true });
  });
});

describe('createCwdAssumedResolver', () => {
  it('joins relative paths against cwd as assumed', () => {
    const resolve = createCwdAssumedResolver('/ws/a');
    expect(resolve('package.json')).toEqual({ path: '/ws/a/package.json', assumed: true });
    expect(resolve('src/x.ts')).toEqual({ path: '/ws/a/src/x.ts', assumed: true });
  });

  it('keeps a POSIX root cwd', () => {
    expect(createCwdAssumedResolver('/')('etc/hosts')).toEqual({ path: '/etc/hosts', assumed: true });
  });

  it('returns null for empty cwd, .. paths, and empty input', () => {
    expect(createCwdAssumedResolver('')('x.ts')).toBeNull();
    const resolve = createCwdAssumedResolver('/ws/a');
    expect(resolve('../x.ts')).toBeNull();
    expect(resolve('')).toBeNull();
  });
});
