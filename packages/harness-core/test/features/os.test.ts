import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { homedir, release, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ToolResult } from '@moonshot-ai/agent-core';

import {
  createNodeOsHost,
  HostFsError,
  type OsHost,
  type OsProcess,
} from '#/features/os/host/index';
import {
  ensureRgPath,
  runRgOnce,
  type RgResolution,
} from '#/features/os/rg/index';
import { startProcessExecution } from '#/features/os/process-exec';
import {
  createBashTool,
  createGlobTool,
  createGrepTool,
  createReadTool,
  createWriteTool,
} from '#/features/os/tools/index';

let workDir: string;
let host: OsHost;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'os-feature-'));
  host = createNodeOsHost();
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function collect(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function resultText(result: ToolResult): string {
  return result.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n');
}

function callTool(name: string, args: Record<string, unknown>): {
  type: 'function';
  id: string;
  name: string;
  arguments: string;
} {
  return { type: 'function', id: `call-${name}`, name, arguments: JSON.stringify(args) };
}

describe('fs', () => {
  it('writes, appends and reads back text', async () => {
    const file = join(workDir, 'note.txt');
    await host.fs.writeText(file, 'alpha');
    await host.fs.appendText(file, '-beta');
    expect(await host.fs.readText(file)).toBe('alpha-beta');
  });

  it('round-trips bytes and reads slices with offset and length', async () => {
    const file = join(workDir, 'blob.bin');
    await host.fs.writeBytes(file, new Uint8Array([1, 2, 3, 4, 5]));
    expect([...(await host.fs.readBytes(file))]).toEqual([1, 2, 3, 4, 5]);
    expect([...(await host.fs.readBytes(file, 2, 1))]).toEqual([2, 3]);
  });

  it('reads lines keeping terminators', async () => {
    const file = join(workDir, 'lines.txt');
    await host.fs.writeText(file, 'one\ntwo\nthree');
    const lines: string[] = [];
    for await (const line of host.fs.readLines(file)) {
      lines.push(line);
    }
    expect(lines).toEqual(['one\n', 'two\n', 'three']);
  });

  it('stats files and lists directory entries', async () => {
    const file = join(workDir, 'entry.txt');
    await host.fs.writeText(file, 'data');
    const stat = await host.fs.stat(file);
    expect(stat.isFile).toBe(true);
    expect(stat.isDirectory).toBe(false);
    expect(stat.size).toBe(4);
    const entries = await host.fs.readdir(workDir);
    expect(entries.some((e) => e.name === 'entry.txt' && e.isFile)).toBe(true);
  });

  it('creates directories recursively and removes trees', async () => {
    const nested = join(workDir, 'a', 'b', 'c');
    await host.fs.mkdir(nested, { recursive: true });
    await host.fs.writeText(join(nested, 'leaf.txt'), 'x');
    await host.fs.remove(join(workDir, 'a'));
    const missing = await host.fs.stat(nested).catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(HostFsError);
    expect((missing as HostFsError).code).toBe('os.fs.not_found');
  });

  it('creates exclusively once and refuses the second time', async () => {
    const file = join(workDir, 'once.txt');
    expect(await host.fs.createExclusive(file, new TextEncoder().encode('first'))).toBe(true);
    expect(await host.fs.createExclusive(file, new TextEncoder().encode('second'))).toBe(false);
    expect(await host.fs.readText(file)).toBe('first');
  });

  it('resolves realpath', async () => {
    const file = join(workDir, 'real.txt');
    await host.fs.writeText(file, 'y');
    const resolved = await host.fs.realpath(file);
    expect(resolved.endsWith('real.txt')).toBe(true);
    expect(resolved.startsWith('/')).toBe(true);
  });

  it('maps ENOENT to not_found', async () => {
    const error = await host.fs.readText(join(workDir, 'missing.txt')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostFsError);
    expect((error as HostFsError).code).toBe('os.fs.not_found');
    expect((error as HostFsError).retryable).toBe(false);
  });

  it('maps EISDIR to is_directory', async () => {
    const error = await host.fs.readText(workDir).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostFsError);
    expect((error as HostFsError).code).toBe('os.fs.is_directory');
  });
});

describe('process', () => {
  it('spawns echo and captures stdout and exit code', async () => {
    const proc = await host.process.spawn('echo', ['hello-os']);
    const [output, code] = await Promise.all([collect(proc.stdout), proc.wait()]);
    expect(output).toBe('hello-os\n');
    expect(code).toBe(0);
    expect(proc.exitCode).toBe(0);
    proc.dispose();
  });

  it('pipes stdin through cat', async () => {
    const proc = await host.process.spawn('cat', []);
    proc.stdin.write('stream-in');
    proc.stdin.end();
    const [output, code] = await Promise.all([collect(proc.stdout), proc.wait()]);
    expect(output).toBe('stream-in');
    expect(code).toBe(0);
    proc.dispose();
  });

  it('reports spawn failures with spawn_failed code', async () => {
    const error = await host.process
      .spawn('definitely-not-a-real-binary-os-test')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: unknown }).code).toBe('os.process.spawn_failed');
  });

  it('kills a long-running process', async () => {
    const proc = await host.process.spawn('sleep', ['30']);
    await proc.kill();
    const code = await proc.wait();
    expect(code).toBe(-1);
    expect(proc.exitCode).toBe(-1);
    proc.dispose();
  });
});

describe('process-exec', () => {
  it('escalates to SIGKILL when the process ignores SIGTERM', async () => {
    const controller = new AbortController();
    const proc = await host.process.spawn('/bin/bash', [
      '-c',
      "trap '' TERM; while :; do :; done",
    ]);
    const execution = startProcessExecution(proc, {
      signal: controller.signal,
      sigtermGraceMs: 100,
    });
    setTimeout(() => controller.abort(), 50);
    const settlement = await execution.done;
    expect(settlement.status).toBe('killed');
  });
});

describe('environment', () => {
  it('exposes a complete environment after ready', async () => {
    await host.environment.ready;
    expect(host.environment.osKind).toBe(process.platform === 'darwin' ? 'macOS' : 'Linux');
    expect(host.environment.osArch).toBe(process.arch);
    expect(host.environment.osVersion).toBe(release());
    expect(['bash', 'sh']).toContain(host.environment.shellName);
    expect(host.environment.shellPath.length).toBeGreaterThan(0);
    expect(host.environment.pathClass).toBe('posix');
    expect(host.environment.homeDir).toBe(homedir());
  });

  it('throws when accessed before ready settles', () => {
    const env = createNodeOsHost().environment;
    expect(() => env.shellPath).toThrow(/before ready/);
  });
});

describe('rg', () => {
  it('locates rg without downloading and greps a fixture tree', async (ctx) => {
    let rg: RgResolution;
    try {
      rg = await ensureRgPath({ allowDownload: false });
    } catch {
      return ctx.skip();
    }
    expect(['system-path', 'share-bin-cached']).toContain(rg.source);

    await host.fs.mkdir(join(workDir, 'sub'), { recursive: true });
    await host.fs.writeText(join(workDir, 'sub', 'haystack.txt'), 'first\nneedle-line\nlast\n');
    await host.fs.writeText(join(workDir, 'other.txt'), 'nothing here\n');

    const outcome = await runRgOnce(
      host.process,
      [rg.path, '--no-heading', 'needle', '.'],
      new AbortController().signal,
      { cwd: workDir },
    );
    expect(outcome.kind).toBe('result');
    if (outcome.kind !== 'result') return;
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdoutText).toContain('needle-line');
    expect(outcome.bufferTruncated).toBe(false);
    expect(outcome.timedOut).toBe(false);
  });

  it('reports exit code 1 when nothing matches', async (ctx) => {
    let rg: RgResolution;
    try {
      rg = await ensureRgPath({ allowDownload: false });
    } catch {
      return ctx.skip();
    }

    await host.fs.writeText(join(workDir, 'plain.txt'), 'alpha\nbeta\n');
    const outcome = await runRgOnce(
      host.process,
      [rg.path, 'zzz-no-such-token', '.'],
      new AbortController().signal,
      { cwd: workDir },
    );
    expect(outcome.kind).toBe('result');
    if (outcome.kind !== 'result') return;
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdoutText).toBe('');
  });
});

describe('write', () => {
  const writeTool = (): ReturnType<typeof createWriteTool> =>
    createWriteTool({ host, workspace: { workDir } });

  it('writes a file and reports UTF-8 byte count', async () => {
    const result = await writeTool().execute({
      toolCall: callTool('Write', { path: 'a.txt', content: 'héllo' }),
      signal: new AbortController().signal,
    });
    expect(resultText(result)).toBe('Wrote 6 bytes to a.txt');
    expect(await host.fs.readText(join(workDir, 'a.txt'))).toBe('héllo');
  });

  it('appends at EOF without adding a newline', async () => {
    await host.fs.writeText(join(workDir, 'log.txt'), 'ab');
    const result = await writeTool().execute({
      toolCall: callTool('Write', { path: 'log.txt', content: 'cd', mode: 'append' }),
      signal: new AbortController().signal,
    });
    expect(resultText(result)).toBe('Appended 2 bytes to log.txt');
    expect(await host.fs.readText(join(workDir, 'log.txt'))).toBe('abcd');
  });

  it('creates missing parent directories automatically', async () => {
    const result = await writeTool().execute({
      toolCall: callTool('Write', { path: 'x/y/z.txt', content: 'deep' }),
      signal: new AbortController().signal,
    });
    expect(resultText(result)).toBe('Wrote 4 bytes to x/y/z.txt');
    expect(await host.fs.readText(join(workDir, 'x', 'y', 'z.txt'))).toBe('deep');
  });

  it('refuses when the parent path is not a directory', async () => {
    await host.fs.writeText(join(workDir, 'blocker'), 'file');
    const result = await writeTool().execute({
      toolCall: callTool('Write', { path: 'blocker/child.txt', content: 'x' }),
      signal: new AbortController().signal,
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('Parent path is not a directory:');
  });

  it('refuses sensitive files with the protective message', async () => {
    const result = await writeTool().execute({
      toolCall: callTool('Write', { path: '.env', content: 'SECRET=1' }),
      signal: new AbortController().signal,
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe(
      '".env" matches a sensitive-file pattern (env / credential / SSH key). Access is blocked to protect secrets.',
    );
  });

  it('refuses relative paths that resolve outside the workspace', async () => {
    const result = await writeTool().execute({
      toolCall: callTool('Write', { path: '../outside.txt', content: 'x' }),
      signal: new AbortController().signal,
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe(
      '"../outside.txt" is not an absolute path. You must provide an absolute path to write or edit a file outside the working directory.',
    );
  });

  it('reports invalid arguments as text', async () => {
    const result = await writeTool().execute({
      toolCall: { type: 'function', id: 'call-Write', name: 'Write', arguments: '{broken' },
      signal: new AbortController().signal,
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe('invalid Write arguments: {broken');
  });
});

describe('read', () => {
  const readTool = (): ReturnType<typeof createReadTool> =>
    createReadTool({ host, workspace: { workDir } });

  const readResult = async (args: Record<string, unknown>): Promise<ToolResult> =>
    readTool().execute({
      toolCall: callTool('Read', args),
      signal: new AbortController().signal,
    });

  const read = async (args: Record<string, unknown>): Promise<string> =>
    resultText(await readResult(args));

  it('renders lines with line numbers and a complete status block', async () => {
    await host.fs.writeText(join(workDir, 'note.txt'), 'alpha\nbeta\n');
    const text = await read({ path: 'note.txt' });
    expect(text.startsWith('1\talpha\n2\tbeta\n<system>')).toBe(true);
    expect(text).toContain('2 lines read from file starting from line 1.');
    expect(text).toContain('Total lines in file: 2.');
    expect(text).toContain('Requested range complete.');
    expect(text).toContain('Effective max_chars: 100000.');
    expect(text).toContain('End of file reached.');
    expect(text.endsWith('</system>')).toBe(true);
  });

  it('pages with line_offset and n_lines', async () => {
    await host.fs.writeText(join(workDir, 'p.txt'), 'l1\nl2\nl3\nl4\nl5\n');
    const text = await read({ path: 'p.txt', line_offset: 2, n_lines: 2 });
    expect(text.startsWith('2\tl2\n3\tl3\n<system>')).toBe(true);
    expect(text).toContain('Requested range complete.');
    expect(text).not.toContain('Next Read:');
  });

  it('offers Next Read continuation arguments when the range is incomplete', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line-${String(i + 1)}-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`).join('\n');
    await host.fs.writeText(join(workDir, 'big.txt'), `${lines}\n`);
    const text = await read({ path: 'big.txt', line_offset: 2, n_lines: 10, max_chars: 400 });
    expect(text).toContain('Character limit reached.');
    expect(text).toContain('Effective max_chars: 400.');
    expect(text).toContain('Total lines in file: 20.');
    const match = /Next Read: (\{[^}]*\})/.exec(text);
    expect(match).not.toBeNull();
    const next = JSON.parse(match![1]!) as Record<string, unknown>;
    expect(next['path']).toBe('big.txt');
    expect(typeof next['line_offset']).toBe('number');
    expect(next['max_chars']).toBe(400);
    expect('column_offset' in next).toBe(false);
  });

  it('reads the tail with a negative line_offset', async () => {
    await host.fs.writeText(join(workDir, 't.txt'), 'l1\nl2\nl3\nl4\nl5\n');
    const text = await read({ path: 't.txt', line_offset: -2 });
    expect(text.startsWith('4\tl4\n5\tl5\n<system>')).toBe(true);
    expect(text).toContain('Requested range complete.');
    expect(text).toContain('End of file reached.');
  });

  it('cuts a column fragment with column_offset', async () => {
    await host.fs.writeText(join(workDir, 'c.txt'), `${'x'.repeat(100)}\nshort\n`);
    const text = await read({ path: 'c.txt', column_offset: 50 });
    expect(text.startsWith(`1\t${'x'.repeat(50)}\n2\tshort\n<system>`)).toBe(true);
    expect(text).toContain('Line 1 fragment: columns [50, 100) of 100. Line complete.');
    expect(text).toContain('Requested range complete.');
  });

  it('displays pure CRLF files with LF line endings', async () => {
    await host.fs.writeBytes(join(workDir, 'crlf.txt'), new TextEncoder().encode('a\r\nb\r\n'));
    const text = await read({ path: 'crlf.txt' });
    expect(text.startsWith('1\ta\n2\tb\n<system>')).toBe(true);
    expect(text).not.toContain('\r');
    expect(text).not.toContain('\\r');
  });

  it('makes carriage returns visible in mixed files and says so', async () => {
    await host.fs.writeBytes(join(workDir, 'mixed.txt'), new TextEncoder().encode('a\r\nb\nc\rd\n'));
    const text = await read({ path: 'mixed.txt' });
    expect(text).toContain('1\ta\\r');
    expect(text).toContain('3\tc\\rd');
    expect(text).toContain('Mixed or lone carriage-return line endings are shown as \\r.');
  });

  it('transcodes small UTF-16 LE files and notes the encoding', async () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi\nthere\n', 'utf16le')]);
    await host.fs.writeBytes(join(workDir, 'wide.txt'), new Uint8Array(bytes));
    const text = await read({ path: 'wide.txt' });
    expect(text.startsWith('1\thi\n2\tthere\n<system>')).toBe(true);
    expect(text).toContain('Detected file encoding: UTF-16 LE');
  });

  it('refuses image files', async () => {
    await host.fs.writeBytes(
      join(workDir, 'pic.png'),
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]),
    );
    const result = await readResult({ path: 'pic.png' });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe('"pic.png" is an image file. Only text files can be read.');
  });

  it('refuses directories', async () => {
    const result = await readResult({ path: '.' });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe('"." is not a file.');
  });

  it('refuses sensitive files', async () => {
    await host.fs.writeText(join(workDir, '.env'), 'SECRET=1\n');
    const result = await readResult({ path: '.env' });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe(
      '".env" matches a sensitive-file pattern (env / credential / SSH key). Access is blocked to protect secrets.',
    );
  });

  it('reports missing files', async () => {
    const result = await readResult({ path: 'missing.txt' });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe('"missing.txt" does not exist.');
  });

  it('rejects column_offset together with a negative line_offset', async () => {
    await host.fs.writeText(join(workDir, 'n.txt'), 'a\nb\n');
    const result = await readResult({ path: 'n.txt', line_offset: -1, column_offset: 2 });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe(
      'column_offset is only supported for forward reads. Use a positive line_offset or the forward Next Read arguments.',
    );
  });

  it('renders the description with the configured limits', () => {
    const tool = createReadTool({
      host,
      workspace: { workDir },
      limits: () => ({ defaultMaxChars: 60, maxChars: 120 }),
    });
    expect(tool.description).toContain('default is 60 characters');
    expect(tool.description).toContain('up to 120');
    expect(readTool().description).toContain('default is 100000 characters');
    expect(readTool().description).toContain('up to 500000');
  });

  it('applies limits() to the effective budget', async () => {
    const tool = createReadTool({
      host,
      workspace: { workDir },
      limits: () => ({ defaultMaxChars: 200, maxChars: 400 }),
    });
    await host.fs.writeText(join(workDir, 'lim.txt'), 'a\nb\nc\n');
    const text = resultText(
      await tool.execute({
        toolCall: callTool('Read', { path: 'lim.txt' }),
        signal: new AbortController().signal,
      }),
    );
    expect(text).toContain('Effective max_chars: 200.');
  });
});

describe('glob', () => {
  const globTool = (): ReturnType<typeof createGlobTool> =>
    createGlobTool({ host, workspace: { workDir } });

  const globResult = async (args: Record<string, unknown>): Promise<ToolResult> =>
    globTool().execute({
      toolCall: callTool('Glob', args),
      signal: new AbortController().signal,
    });

  const glob = async (args: Record<string, unknown>): Promise<string> =>
    resultText(await globResult(args));

  const rgOrSkip = async (ctx: { skip(): unknown }): Promise<RgResolution | undefined> => {
    try {
      return await ensureRgPath({ allowDownload: false });
    } catch {
      ctx.skip();
      return undefined;
    }
  };

  it('lists matching files most-recently-modified first', async (ctx) => {
    if ((await rgOrSkip(ctx)) === undefined) return;
    await host.fs.writeText(join(workDir, 'old.ts'), 'old');
    await host.fs.writeText(join(workDir, 'new.ts'), 'new');
    await utimes(join(workDir, 'old.ts'), new Date('2001-01-01'), new Date('2001-01-01'));
    const text = await glob({ pattern: '*.ts' });
    const lines = text.split('\n');
    expect(lines).toContain('new.ts');
    expect(lines).toContain('old.ts');
    expect(lines.indexOf('new.ts')).toBeLessThan(lines.indexOf('old.ts'));
  });

  it('reports a full page with the Found N matches footer', async (ctx) => {
    if ((await rgOrSkip(ctx)) === undefined) return;
    await host.fs.writeText(join(workDir, 'f1.hit.ts'), '1');
    await host.fs.writeText(join(workDir, 'f2.hit.ts'), '2');
    const text = await glob({ pattern: '*.hit.ts', head_limit: 2 });
    expect(text).toContain('Found 2 matches');
    expect(text).not.toContain('Showing matches');
  });

  it('pages with head_limit and offset', async (ctx) => {
    if ((await rgOrSkip(ctx)) === undefined) return;
    for (const name of ['p1.ts', 'p2.ts', 'p3.ts', 'p4.ts', 'p5.ts']) {
      await host.fs.writeText(join(workDir, name), name);
    }
    const page1 = await glob({ pattern: 'p?.ts', head_limit: 2 });
    expect(page1).toContain('Showing matches 1–2 of 5.');
    expect(page1).toContain('Continue with the same search arguments and offset=2.');
    const page2 = await glob({ pattern: 'p?.ts', head_limit: 2, offset: 2 });
    expect(page2).toContain('Showing matches 3–4 of 5.');
    expect(page2).toContain('Continue with the same search arguments and offset=4.');
  });

  it('reports no matches', async (ctx) => {
    if ((await rgOrSkip(ctx)) === undefined) return;
    await host.fs.writeText(join(workDir, 'solo.txt'), 'x');
    expect(await glob({ pattern: '*.never-matches' })).toBe('No matches found');
  });

  it('filters sensitive files and reports the count', async (ctx) => {
    if ((await rgOrSkip(ctx)) === undefined) return;
    await host.fs.writeText(join(workDir, '.env.production'), 'SECRET=1');
    await host.fs.writeText(join(workDir, 'visible.txt'), 'v');
    const text = await glob({ pattern: '*' });
    expect(text).toContain('visible.txt');
    expect(text).not.toContain('.env.production');
    expect(text).toContain('Filtered 1 sensitive file(s).');
  });

  it('rejects a search path that is not a directory', async (ctx) => {
    if ((await rgOrSkip(ctx)) === undefined) return;
    await host.fs.writeText(join(workDir, 'plain.txt'), 'x');
    const result = await globResult({ pattern: '*', path: 'plain.txt' });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe(`${join(workDir, 'plain.txt')} is not a directory`);
  });

  it('rejects a search path that does not exist', async (ctx) => {
    if ((await rgOrSkip(ctx)) === undefined) return;
    const result = await globResult({ pattern: '*', path: 'nope' });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe(`${join(workDir, 'nope')} does not exist`);
  });

  it('honors ignore files by default and include_ignored when set', async (ctx) => {
    if ((await rgOrSkip(ctx)) === undefined) return;
    execFileSync('git', ['init', '-q'], { cwd: workDir });
    await host.fs.writeText(join(workDir, '.gitignore'), 'ignored-dir/\n');
    await host.fs.mkdir(join(workDir, 'ignored-dir'), { recursive: true });
    await host.fs.writeText(join(workDir, 'ignored-dir', 'x.ts'), 'x');
    await host.fs.mkdir(join(workDir, 'visible'), { recursive: true });
    await host.fs.writeText(join(workDir, 'visible', 'y.ts'), 'y');
    const hidden = await glob({ pattern: '*.ts' });
    expect(hidden).toContain('visible/y.ts');
    expect(hidden).not.toContain('ignored-dir/x.ts');
    const shown = await glob({ pattern: '*.ts', include_ignored: true });
    expect(shown).toContain('visible/y.ts');
    expect(shown).toContain('ignored-dir/x.ts');
  });
});

describe('grep', () => {
  const grepTool = (): ReturnType<typeof createGrepTool> =>
    createGrepTool({ host, workspace: { workDir } });

  const grep = async (args: Record<string, unknown>): Promise<string> =>
    resultText(
      await grepTool().execute({
        toolCall: callTool('Grep', args),
        signal: new AbortController().signal,
      }),
    );

  const rgOrSkip = async (ctx: { skip(): unknown }): Promise<RgResolution | undefined> => {
    try {
      return await ensureRgPath({ allowDownload: false });
    } catch {
      ctx.skip();
      return undefined;
    }
  };

  it('lists files with matches by default', async (ctx) => {
    if ((await rgOrSkip(ctx)) === undefined) return;
    await host.fs.writeText(join(workDir, 'a.txt'), 'needle one\n');
    await host.fs.writeText(join(workDir, 'b.txt'), 'needle two\n');
    await host.fs.writeText(join(workDir, 'c.txt'), 'hay\n');
    const text = await grep({ pattern: 'needle' });
    expect(text).toContain('a.txt');
    expect(text).toContain('b.txt');
    expect(text).not.toContain('c.txt');
  });

  it('shows content lines with line numbers', async (ctx) => {
    if ((await rgOrSkip(ctx)) === undefined) return;
    await host.fs.writeText(join(workDir, 'b.txt'), 'foo\nneedle here\nbar\n');
    const text = await grep({ pattern: 'needle', output_mode: 'content' });
    expect(text).toContain('b.txt:2:needle here');
  });

  it('summarizes count matches with a header line', async (ctx) => {
    if ((await rgOrSkip(ctx)) === undefined) return;
    await host.fs.writeText(join(workDir, 'a.txt'), 'x\nx\ny\n');
    await host.fs.writeText(join(workDir, 'b.txt'), 'x\n');
    const text = await grep({ pattern: '^x$', output_mode: 'count_matches' });
    const lines = text.split('\n');
    expect(lines[0]).toBe('Found 3 total occurrences across 2 files.');
    expect(lines).toContain('a.txt:2');
    expect(lines).toContain('b.txt:1');
  });

  it('scopes the search with a glob filter', async (ctx) => {
    if ((await rgOrSkip(ctx)) === undefined) return;
    await host.fs.writeText(join(workDir, 'a.ts'), 'needle\n');
    await host.fs.writeText(join(workDir, 'b.md'), 'needle\n');
    const text = await grep({ pattern: 'needle', glob: '*.md' });
    expect(text).toContain('b.md');
    expect(text).not.toContain('a.ts');
  });

  it('searches case-insensitively with -i', async (ctx) => {
    if ((await rgOrSkip(ctx)) === undefined) return;
    await host.fs.writeText(join(workDir, 'case.txt'), 'Needle in HAY\n');
    const text = await grep({ pattern: 'needle', '-i': true, output_mode: 'content' });
    expect(text).toContain('case.txt:1:Needle in HAY');
  });

  it('truncates pages with head_limit and points at the next offset', async (ctx) => {
    if ((await rgOrSkip(ctx)) === undefined) return;
    await host.fs.writeText(join(workDir, 'm1.txt'), 'needle\n');
    await host.fs.writeText(join(workDir, 'm2.txt'), 'needle\n');
    await host.fs.writeText(join(workDir, 'm3.txt'), 'needle\n');
    await utimes(join(workDir, 'm1.txt'), new Date('2001-01-01'), new Date('2001-01-01'));
    await utimes(join(workDir, 'm2.txt'), new Date('2002-01-01'), new Date('2002-01-01'));
    await utimes(join(workDir, 'm3.txt'), new Date('2003-01-01'), new Date('2003-01-01'));
    const text = await grep({ pattern: 'needle', head_limit: 2 });
    expect(text).toContain('Results truncated to 2 lines (total: 3). Use offset=2 to see more.');
    const rest = await grep({ pattern: 'needle', head_limit: 2, offset: 2 });
    expect(rest).not.toContain('Results truncated');
    expect(rest).toContain('m1.txt');
  });

  it('reports no matches with the sensitive-aware message', async (ctx) => {
    if ((await rgOrSkip(ctx)) === undefined) return;
    await host.fs.writeText(join(workDir, 'solo.txt'), 'hay\n');
    expect(await grep({ pattern: 'zzz-absent' })).toBe('No non-sensitive matches found');
  });

  it('filters sensitive file contents and reports the filtered paths', async (ctx) => {
    if ((await rgOrSkip(ctx)) === undefined) return;
    await host.fs.writeText(join(workDir, '.env.production'), 'needle-secret=1\n');
    await host.fs.writeText(join(workDir, 'normal.txt'), 'needle\n');
    const text = await grep({ pattern: 'needle', output_mode: 'content' });
    expect(text).toContain('normal.txt:1:needle');
    expect(text).not.toContain('needle-secret');
    expect(text).toContain('Filtered 1 sensitive file(s): .env.production');
  });
});

describe('bash', () => {
  const bashTool = (opts?: {
    autoBackgroundOnTimeout?: () => boolean;
    backgroundTaskTimeoutS?: () => number;
    spillThresholdChars?: () => number;
  }): ReturnType<typeof createBashTool> =>
    createBashTool({
      host,
      workspace: { workDir },
      spillDir: join(workDir, 'spill'),
      autoBackgroundOnTimeout: opts?.autoBackgroundOnTimeout,
      backgroundTaskTimeoutS: opts?.backgroundTaskTimeoutS,
      spillThresholdChars: opts?.spillThresholdChars,
    });

  const bashResult = async (
    args: Record<string, unknown>,
    extra?: { detach?: (text: string) => void; signal?: AbortSignal },
  ): Promise<ToolResult> =>
    bashTool().execute({
      toolCall: callTool('Bash', args),
      signal: extra?.signal ?? new AbortController().signal,
      detach: extra?.detach,
    });

  const bash = async (
    args: Record<string, unknown>,
    extra?: { detach?: (text: string) => void; signal?: AbortSignal },
  ): Promise<string> => resultText(await bashResult(args, extra));

  it('returns only the output on success', async () => {
    const result = await bashResult({ command: 'echo hello-os' });
    expect(result.isError).toBeUndefined();
    expect(resultText(result)).toBe('hello-os\n');
  });

  it('reports an empty success', async () => {
    const result = await bashResult({ command: 'true' });
    expect(result.isError).toBeUndefined();
    expect(resultText(result)).toBe('Command executed successfully.');
  });

  it('appends the exit code on failure and backfills an empty buffer', async () => {
    const withOutput = await bashResult({ command: 'echo oops; exit 3' });
    expect(withOutput.isError).toBe(true);
    expect(resultText(withOutput)).toContain('oops');
    expect(resultText(withOutput).endsWith('Command failed with exit code: 3.')).toBe(true);
    const empty = await bashResult({ command: 'exit 3' });
    expect(empty.isError).toBe(true);
    expect(resultText(empty)).toBe('Process exited with code 3\nCommand failed with exit code: 3.');
  });

  it('validates empty commands, background description and the timeout cap', async () => {
    const emptyCommand = await bashResult({ command: '' });
    expect(emptyCommand.isError).toBe(true);
    expect(resultText(emptyCommand)).toBe('Command cannot be empty.');
    const noDescription = await bashResult({ command: 'true', run_in_background: true });
    expect(noDescription.isError).toBe(true);
    expect(resultText(noDescription)).toBe('description is required when run_in_background is true.');
    const overForeground = await bashResult({ command: 'true', timeout: 301 });
    expect(overForeground.isError).toBe(true);
    expect(resultText(overForeground)).toBe('timeout must be ≤ 300s (foreground)');
    const overBackground = await bashResult({
      command: 'true',
      run_in_background: true,
      description: 'd',
      timeout: 86401,
    });
    expect(overBackground.isError).toBe(true);
    expect(resultText(overBackground)).toBe('timeout must be ≤ 86400s (background)');
  });

  it('resolves a relative cwd against the workspace', async () => {
    await host.fs.mkdir(join(workDir, 'sub'));
    const text = await bash({ command: 'pwd', cwd: 'sub' });
    expect(text.trim()).toBe(join(workDir, 'sub'));
  });

  it('kills a foreground command on timeout when auto-background is off', async () => {
    const tool = createBashTool({
      host,
      workspace: { workDir },
      spillDir: join(workDir, 'spill'),
      autoBackgroundOnTimeout: () => false,
    });
    const result = await tool.execute({
      toolCall: callTool('Bash', { command: 'sleep 5', timeout: 1 }),
      signal: new AbortController().signal,
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe('Command killed by timeout (1s)');
  });

  it('detaches a foreground command on timeout and resolves with the completion', async () => {
    const acks: string[] = [];
    const text = await bash(
      { command: 'echo early; sleep 2; echo late', timeout: 1 },
      { detach: (ack) => acks.push(ack) },
    );
    expect(acks).toHaveLength(1);
    expect(acks[0]).toContain('Command timed out and moved to background');
    expect(acks[0]).toContain('task_id: call-Bash');
    expect(acks[0]).toContain('status: running');
    expect(acks[0]).toContain('foreground_output:\nearly\n');
    expect(text).toBe('early\nlate\n');
  });

  it('detaches immediately for run_in_background with the metadata block in field order', async () => {
    const acks: string[] = [];
    const text = await bash(
      { command: 'echo bg-done', run_in_background: true, description: 'bg task' },
      { detach: (ack) => acks.push(ack) },
    );
    expect(acks).toHaveLength(1);
    const ack = acks[0]!;
    const order = [
      'task_id: call-Bash',
      'pid: ',
      'description: bg task',
      'status: running',
      'automatic_notification: true',
      'next_step: ',
      'human_shell_hint: The task is visible in the background-task panel.',
    ];
    for (let i = 1; i < order.length; i += 1) {
      expect(ack.indexOf(order[i]!)).toBeGreaterThan(ack.indexOf(order[i - 1]!));
    }
    expect(ack.indexOf('task_id:')).toBe(0);
    expect(ack).toContain('The completion arrives automatically in a later turn');
    expect(ack).toContain('next_step: Use TaskStop only if the task must be cancelled.');
    expect(text).toBe('bg-done\n');
  });

  it('reports user interruption', async () => {
    const controller = new AbortController();
    const pending = bashResult(
      { command: 'sleep 30' },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe('Interrupted by user');
  });

  it('detaches a foreground command via the pending map', async () => {
    const acks: string[] = [];
    const tool = bashTool();
    const execute = tool.execute({
      toolCall: callTool('Bash', { command: 'echo first; sleep 1; echo second' }),
      signal: new AbortController().signal,
      detach: (ack) => acks.push(ack),
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(tool.pending.running()).toContain('call-Bash');
    expect(tool.pending.detach('call-Bash')).toBe(true);
    expect(tool.pending.running()).not.toContain('call-Bash');
    expect(tool.pending.detach('call-Bash')).toBe(false);
    expect(acks).toHaveLength(1);
    expect(acks[0]).toContain('Task moved to background by the user');
    expect(acks[0]).toContain('detached_by_user: true');
    expect(resultText(await execute)).toBe('first\nsecond\n');
  });

  it('spills large foreground output to the spill dir with a Read pointer', async () => {
    const tool = createBashTool({
      host,
      workspace: { workDir },
      spillDir: join(workDir, 'spill'),
      spillThresholdChars: () => 100,
    });
    const text = resultText(
      await tool.execute({
        toolCall: callTool('Bash', { command: "head -c 500 /dev/zero | tr '\\0' 'x'" }),
        signal: new AbortController().signal,
      }),
    );
    expect(text).toContain('task_id: call-Bash');
    expect(text).toContain('output_size_bytes: 500');
    expect(text).toContain(`Use Read with path="${join(workDir, 'spill', 'bash-call-Bash.txt')}"`);
    const spilled = await host.fs.readText(join(workDir, 'spill', 'bash-call-Bash.txt'));
    expect(spilled).toBe('x'.repeat(500));
  });

  it('forwards an external terminal handle as the first tool update', async () => {
    const fakeProc: OsProcess = {
      pid: 4242,
      external: { kind: 'terminal', id: 'term-1' },
      exitCode: 0,
      stdin: { write: () => {}, end: () => {} },
      stdout: (async function* () {
        yield new TextEncoder().encode('hello-os\n');
      })(),
      stderr: (async function* () {})(),
      wait: async () => 0,
      kill: async () => {},
      dispose: () => {},
    };
    const terminalHost: OsHost = {
      ...host,
      process: { spawn: async () => fakeProc },
    };
    const tool = createBashTool({
      host: terminalHost,
      workspace: { workDir },
      spillDir: join(workDir, 'spill'),
    });
    const updates: Array<{ key: string; text: string }> = [];
    const text = resultText(
      await tool.execute({
        toolCall: callTool('Bash', { command: 'echo hello-os' }),
        signal: new AbortController().signal,
        onUpdate: (update) => updates.push(update),
      }),
    );
    expect(text).toBe('hello-os\n');
    expect(updates[0]).toEqual({ key: 'terminal', text: 'term-1' });
  });
});

describe('os feature', () => {
  it('registers the five tools, exposes BashRef, and wires config sections', async () => {
    const {
      ConfigRef,
      MAIN_AGENT_ID,
      MemoryBackend,
      Trees,
      createConfig,
      createFeature,
      createUserMessage,
      createHarness,
      openBlobs,
      openSessionStores,
      UNKNOWN_CAPABILITY,
      useAgent,
    } = await import('@moonshot-ai/agent-core');
    const { createOs, BashRef, resolveAgentTaskConfig, resolvePrintBackgroundMode } = await import(
      '#/features/os/index'
    );
    const model = { provider: 'test', model: 'test-model', capability: UNKNOWN_CAPABILITY };
    const seen: { tools: string[] } = { tools: [] };
    const requester = {
      generate: async (_config: unknown, content: { tools?: readonly { name: string }[] }, hooks: { onEvent?: (event: unknown) => void }) => {
        seen.tools = (content.tools ?? []).map((tool) => tool.name);
        const emit = hooks.onEvent ?? (() => undefined);
        emit({ type: 'llm.streaming.part', part: { type: 'text', text: 'ok' } });
        emit({ type: 'llm.streaming.usage', usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 } });
        emit({ type: 'llm.done' });
      },
    };
    const bindLlm = createFeature('test-llm', {
      agent() {
        const agent = useAgent();
        agent.setConfig({ model });
        agent.setRequester(requester as never);
      },
    });
    const backend = new MemoryBackend();
    const trees = await Trees.open(backend.trees, {});
    const tree = await trees.tree('sess');
    const stores = await openSessionStores(tree, openBlobs(backend.blobs));
    const persist = {
      load: () =>
        Promise.resolve(
          '[task]\nbash_task_timeout_s = 42\nbash_auto_background_on_timeout = false\n\n[background]\nprint_max_turns = 7\nkeep_alive_on_exit = true\n',
        ),
      save: () => Promise.resolve(),
    };
    const app = createHarness({
      features: [createConfig({ persist }), createOs({ workDir }), bindLlm],
    });
    const session = await app.create({ sessionId: 'sess', stores });
    const main = await session.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'main-host' });
    try {
      const done = new Promise<void>((resolve) => {
        main.on('turn.done', () => {
          resolve();
        });
      });
      main.submit(createUserMessage('hi'));
      await done;

      expect(seen.tools).toEqual(expect.arrayContaining(['Bash', 'Glob', 'Grep', 'Read', 'Write']));

      const bash = main.resolve(BashRef);
      expect(bash.running()).toEqual([]);

      const config = app.resolve(ConfigRef);
      expect(config.get('read')).toEqual({});
      expect(config.get('task')).toEqual({
        bashTaskTimeoutS: 42,
        bashAutoBackgroundOnTimeout: false,
      });
      expect(config.get('background')).toEqual({ printMaxTurns: 7, keepAliveOnExit: true });
      expect(resolveAgentTaskConfig(config)).toEqual({
        bashTaskTimeoutS: 42,
        bashAutoBackgroundOnTimeout: false,
        printMaxTurns: 7,
        keepAliveOnExit: true,
      });
      expect(resolvePrintBackgroundMode(config)).toBe('drain');
      await config.set('read', { defaultMaxChars: 60, maxChars: 120 }, 'memory');
      expect(config.get('read')).toEqual({ defaultMaxChars: 60, maxChars: 120 });
    } finally {
      await app.disposeAsync();
      await stores.dispose();
    }
  });
});
