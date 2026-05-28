import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { localKaos } from '@moonshot-ai/kaos';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExecutableToolResult, ToolExecution } from '../../src/loop';
import type { TelemetryClient } from '../../src/telemetry';
import { MemoryTool, type MemoryInput } from '../../src/tools/builtin/state/memory';
import type { WorkspaceConfig } from '../../src/tools/support/workspace';

let homeDir: string;
let workDir: string;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'kimi-memory-home-'));
  workDir = await mkdtemp(join(tmpdir(), 'kimi-memory-work-'));
  vi.spyOn(localKaos, 'gethome').mockReturnValue(homeDir);
  await mkdir(join(workDir, '.git'), { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(homeDir, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
});

const workspace = (): WorkspaceConfig => ({ workspaceDir: workDir, additionalDirs: [] });

const projectMemoryDir = (): string => join(workDir, '.kimi-code', 'memory');
const userMemoryDir = (): string => join(homeDir, '.kimi-code', 'memory');

const signal = new AbortController().signal;

async function runTool(args: MemoryInput): Promise<ExecutableToolResult> {
  const tool = new MemoryTool(localKaos, workspace());
  const execution: ToolExecution = tool.resolveExecution(args);
  if (execution.isError === true) return execution;
  return execution.execute({
    turnId: '0',
    toolCallId: 'call_memory',
    signal,
  });
}

async function seedFact(
  dir: string,
  slug: string,
  record: { name: string; description: string; type: string },
  body = 'body',
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const text = `---\nname: ${record.name}\ndescription: ${record.description}\ntype: ${record.type}\n---\n\n${body}\n`;
  await writeFile(join(dir, `${slug}.md`), text, 'utf-8');
}

describe('MemoryTool write operations', () => {
  it('creates a new fact at the project-scope path with matching frontmatter', async () => {
    const result = await runTool({
      operation: 'write',
      scope: 'project',
      record: {
        name: 'preferred-test-runner',
        description: 'Use vitest, never jest.',
        type: 'project',
      },
      body: 'Use vitest, never jest.',
    });

    expect(result.isError).not.toBe(true);
    const text = await readFile(
      join(projectMemoryDir(), 'preferred-test-runner.md'),
      'utf-8',
    );
    expect(text).toContain('name: preferred-test-runner');
    expect(text).toContain('description: Use vitest, never jest.');
    expect(text).toContain('type: project');
    expect(text).toContain('Use vitest, never jest.');

    const output = typeof result.output === 'string' ? result.output : '';
    expect(output).toContain('preferred-test-runner');
    expect(output).toContain('project');
  });

  it('writes the body via a tmp-rename sequence and leaves no .tmp- file behind', async () => {
    const originalWriteText = localKaos.writeText.bind(localKaos);
    const writeTextSpy = vi
      .spyOn(localKaos, 'writeText')
      .mockImplementation((path, data, options) =>
        originalWriteText(path, data, options),
      );

    const result = await runTool({
      operation: 'write',
      scope: 'project',
      record: {
        name: 'atomic-fact',
        description: 'Atomic write check.',
        type: 'project',
      },
      body: 'atomic body',
    });

    expect(result.isError).not.toBe(true);

    const writeCalls = writeTextSpy.mock.calls.map(([path]) => path as string);
    const tmpCall = writeCalls.find((p) => p.includes('.tmp-'));
    expect(tmpCall).toBeDefined();
    expect(tmpCall!.endsWith('-atomic-fact.md')).toBe(true);

    const finalPath = join(projectMemoryDir(), 'atomic-fact.md');
    const finalText = await readFile(finalPath, 'utf-8');
    expect(finalText).toContain('atomic body');

    const remaining = await readdir(projectMemoryDir());
    expect(remaining.some((name) => name.includes('.tmp-'))).toBe(false);
  });

  it('rejects a duplicate slug with reason EXISTS and preserves the existing file', async () => {
    await seedFact(
      projectMemoryDir(),
      'code-style',
      { name: 'code-style', description: 'Use 2-space indent.', type: 'project' },
      'original body',
    );

    const result = await runTool({
      operation: 'write',
      scope: 'project',
      record: {
        name: 'code-style',
        description: 'A different description.',
        type: 'project',
      },
      body: 'replacement body',
    });

    expect(result.isError).toBe(true);
    const output = typeof result.output === 'string' ? result.output : '';
    expect(output).toContain('EXISTS');
    expect(output).toContain('update');

    const existing = await readFile(join(projectMemoryDir(), 'code-style.md'), 'utf-8');
    expect(existing).toContain('original body');
    expect(existing).toContain('Use 2-space indent.');
  });

  it('rejects a body larger than 4 KB with reason BODY_TOO_LARGE and writes no file', async () => {
    const oversizedBody = 'x'.repeat(4097);
    const result = await runTool({
      operation: 'write',
      scope: 'project',
      record: {
        name: 'too-large',
        description: 'oversize.',
        type: 'project',
      },
      body: oversizedBody,
    });

    expect(result.isError).toBe(true);
    const output = typeof result.output === 'string' ? result.output : '';
    expect(output).toContain('BODY_TOO_LARGE');
    expect(output).toContain('4');

    const projectDirExists = await readdir(projectMemoryDir()).catch(() => null);
    if (projectDirExists !== null) {
      expect(projectDirExists.includes('too-large.md')).toBe(false);
    }
  });

  it('rejects missing record.type with the accepted enum values enumerated', async () => {
    const result = await runTool({
      operation: 'write',
      scope: 'project',
      // missing `type` — intentionally malformed for schema rejection
      record: {
        name: 'no-type',
        description: 'no type field',
      } as unknown as MemoryInput extends { record: infer R } ? R : never,
      body: 'irrelevant',
    } as MemoryInput);

    expect(result.isError).toBe(true);
    const output = typeof result.output === 'string' ? result.output : '';
    expect(output).toContain('type');
    expect(output).toContain('user');
    expect(output).toContain('feedback');
    expect(output).toContain('project');
    expect(output).toContain('reference');
  });

  it('writes a body containing secret-looking content but emits a category warning', async () => {
    const result = await runTool({
      operation: 'write',
      scope: 'project',
      record: {
        name: 'has-secret',
        description: 'Contains a sample key.',
        type: 'project',
      },
      body: 'token=sk-ant-xxxxxxxxxxxxxxxxxxxx end',
    });

    expect(result.isError).not.toBe(true);
    const output = typeof result.output === 'string' ? result.output : '';
    expect(output.toLowerCase()).toContain('warning');
    // Category name, not the raw match.
    expect(output).toContain('anthropic-key');
    expect(output).not.toContain('sk-ant-xxxxxxxxxxxxxxxxxxxx');

    const written = await readFile(join(projectMemoryDir(), 'has-secret.md'), 'utf-8');
    expect(written).toContain('sk-ant-xxxxxxxxxxxxxxxxxxxx');
  });
});

describe('MemoryTool read operations', () => {
  it('view returns the merged index grouped by scope with no body content', async () => {
    await seedFact(
      projectMemoryDir(),
      'build',
      { name: 'build', description: 'Repo build instructions.', type: 'project' },
      'EXCLUSIVE_BODY_TOKEN_PROJECT',
    );
    await seedFact(
      userMemoryDir(),
      'style',
      { name: 'style', description: 'Personal tone preference.', type: 'user' },
      'EXCLUSIVE_BODY_TOKEN_USER',
    );

    const result = await runTool({ operation: 'view' });

    expect(result.isError).not.toBe(true);
    const output = typeof result.output === 'string' ? result.output : '';
    expect(output).toContain('## Project');
    expect(output).toContain('## User');
    expect(output).toContain('build');
    expect(output).toContain('style');
    expect(output).toContain('(project)');
    expect(output).toContain('(user)');
    expect(output).not.toContain('EXCLUSIVE_BODY_TOKEN_PROJECT');
    expect(output).not.toContain('EXCLUSIVE_BODY_TOKEN_USER');
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(8 * 1024);
  });

  it('list filters by type and returns only matching slugs', async () => {
    await seedFact(projectMemoryDir(), 'cmd', {
      name: 'cmd',
      description: 'Use pnpm.',
      type: 'project',
    });
    await seedFact(projectMemoryDir(), 'doc', {
      name: 'doc',
      description: 'See readme.',
      type: 'reference',
    });

    const result = await runTool({ operation: 'list', type: 'reference' });

    expect(result.isError).not.toBe(true);
    const output = typeof result.output === 'string' ? result.output : '';
    expect(output).toContain('doc');
    expect(output).not.toContain('cmd');
  });

  it('list filters by scope and returns only user-scope slugs', async () => {
    await seedFact(projectMemoryDir(), 'build', {
      name: 'build',
      description: 'Use pnpm build.',
      type: 'project',
    });
    await seedFact(userMemoryDir(), 'tone', {
      name: 'tone',
      description: 'Be friendly.',
      type: 'user',
    });

    const result = await runTool({ operation: 'list', scope: 'user' });

    expect(result.isError).not.toBe(true);
    const output = typeof result.output === 'string' ? result.output : '';
    expect(output).toContain('tone');
    expect(output).not.toContain('build');
  });

  it('list returns every project fact even when the injected index would truncate', async () => {
    await mkdir(projectMemoryDir(), { recursive: true });
    for (let i = 0; i < 200; i++) {
      const slug = `fact-${String(i).padStart(3, '0')}`;
      await seedFact(projectMemoryDir(), slug, {
        name: slug,
        description: `Description for ${slug}, somewhat lengthy to push past 8 KB.`,
        type: 'project',
      });
    }

    const viewResult = await runTool({ operation: 'view' });
    const viewOutput = typeof viewResult.output === 'string' ? viewResult.output : '';
    expect(Buffer.byteLength(viewOutput, 'utf8')).toBeLessThanOrEqual(8 * 1024);
    expect(viewOutput).toContain('truncated');

    const listResult = await runTool({ operation: 'list', scope: 'project' });
    const listOutput = typeof listResult.output === 'string' ? listResult.output : '';
    for (let i = 0; i < 200; i++) {
      const slug = `fact-${String(i).padStart(3, '0')}`;
      expect(listOutput).toContain(slug);
    }
  });

  it('read returns the full body and frontmatter of a named fact', async () => {
    await seedFact(
      projectMemoryDir(),
      'build',
      { name: 'build', description: 'Use pnpm build.', type: 'project' },
      'pnpm build',
    );

    const result = await runTool({ operation: 'read', scope: 'project', name: 'build' });

    expect(result.isError).not.toBe(true);
    const output = typeof result.output === 'string' ? result.output : '';
    expect(output).toContain('pnpm build');
    expect(output).toContain('name: build');
    expect(output).toContain('description: Use pnpm build.');
    expect(output).toContain('type: project');
  });

  it('read of an unknown slug returns NOT_FOUND naming slug, scope, and suggesting list', async () => {
    await mkdir(projectMemoryDir(), { recursive: true });

    const result = await runTool({ operation: 'read', scope: 'project', name: 'no-such-fact' });

    expect(result.isError).toBe(true);
    const output = typeof result.output === 'string' ? result.output : '';
    expect(output).toContain('NOT_FOUND');
    expect(output).toContain('no-such-fact');
    expect(output).toContain('project');
    expect(output.toLowerCase()).toContain('list');
  });
});

describe('MemoryTool update and delete operations', () => {
  it('update replaces the body atomically and the new content is visible on disk', async () => {
    await seedFact(
      projectMemoryDir(),
      'build',
      { name: 'build', description: 'Use pnpm build.', type: 'project' },
      'old',
    );

    const originalWriteText = localKaos.writeText.bind(localKaos);
    const writeTextSpy = vi
      .spyOn(localKaos, 'writeText')
      .mockImplementation((path, data, options) => originalWriteText(path, data, options));

    const result = await runTool({
      operation: 'update',
      scope: 'project',
      name: 'build',
      body: 'new',
    });

    expect(result.isError).not.toBe(true);

    const finalText = await readFile(join(projectMemoryDir(), 'build.md'), 'utf-8');
    expect(finalText).toContain('new');
    expect(finalText).not.toContain('\nold\n');

    const tmpCalls = writeTextSpy.mock.calls
      .map(([path]) => path as string)
      .filter((p) => p.includes('.tmp-'));
    expect(tmpCalls.length).toBeGreaterThan(0);

    const remaining = await readdir(projectMemoryDir());
    expect(remaining.some((name) => name.includes('.tmp-'))).toBe(false);
  });

  it('update merges partial frontmatter while preserving body and other fields', async () => {
    await seedFact(
      projectMemoryDir(),
      'build',
      { name: 'build', description: 'Use pnpm', type: 'project' },
      'original body content',
    );

    const result = await runTool({
      operation: 'update',
      scope: 'project',
      name: 'build',
      record: { description: 'Use pnpm exclusively' },
    });

    expect(result.isError).not.toBe(true);
    const text = await readFile(join(projectMemoryDir(), 'build.md'), 'utf-8');
    expect(text).toContain('description: Use pnpm exclusively');
    expect(text).toContain('type: project');
    expect(text).toContain('name: build');
    expect(text).toContain('original body content');
  });

  it('update of an unknown slug returns NOT_FOUND and creates no new file', async () => {
    await mkdir(projectMemoryDir(), { recursive: true });

    const result = await runTool({
      operation: 'update',
      scope: 'project',
      name: 'ghost',
      body: 'new',
    });

    expect(result.isError).toBe(true);
    const output = typeof result.output === 'string' ? result.output : '';
    expect(output).toContain('NOT_FOUND');

    const remaining = await readdir(projectMemoryDir());
    expect(remaining.includes('ghost.md')).toBe(false);
  });

  it('delete removes the body file and subsequent view omits the slug', async () => {
    await seedFact(
      projectMemoryDir(),
      'obsolete',
      { name: 'obsolete', description: 'Old fact.', type: 'project' },
    );
    await seedFact(
      projectMemoryDir(),
      'keep',
      { name: 'keep', description: 'Still here.', type: 'project' },
    );

    const result = await runTool({ operation: 'delete', scope: 'project', name: 'obsolete' });

    expect(result.isError).not.toBe(true);

    const remaining = await readdir(projectMemoryDir());
    expect(remaining.includes('obsolete.md')).toBe(false);
    expect(remaining.includes('keep.md')).toBe(true);

    const viewResult = await runTool({ operation: 'view' });
    const viewOutput = typeof viewResult.output === 'string' ? viewResult.output : '';
    expect(viewOutput).not.toContain('obsolete');
    expect(viewOutput).toContain('keep');
  });

  it('deleting the last fact leaves the scope dir intact and omits the section', async () => {
    await seedFact(
      projectMemoryDir(),
      'only-one',
      { name: 'only-one', description: 'Sole fact.', type: 'project' },
    );

    const result = await runTool({ operation: 'delete', scope: 'project', name: 'only-one' });
    expect(result.isError).not.toBe(true);

    // Scope dir still exists.
    const remaining = await readdir(projectMemoryDir());
    expect(remaining).toEqual([]);

    // Project section gone; user empty too → whole index empty.
    const viewResult = await runTool({ operation: 'view' });
    const viewOutput = typeof viewResult.output === 'string' ? viewResult.output : '';
    expect(viewOutput).not.toContain('## Project');
    expect(viewOutput).not.toContain('## User');
    // The view handler treats an empty index as a friendly message.
    expect(viewOutput.toLowerCase()).toContain('no memory facts');
  });
});

describe('MemoryTool security', () => {
  it('rejects a write whose slug contains "../escape" without touching disk', async () => {
    const writeSpy = vi.spyOn(localKaos, 'writeText');

    const result = await runTool({
      operation: 'write',
      scope: 'project',
      record: {
        name: '../escape',
        description: 'attempted traversal',
        type: 'project',
      },
      body: 'noop',
    });

    expect(result.isError).toBe(true);
    const output = typeof result.output === 'string' ? result.output : '';
    expect(output).toMatch(/INVALID_SLUG|PATH_OUTSIDE_WORKSPACE|PATH_OUTSIDE_SCOPE/);

    expect(writeSpy).not.toHaveBeenCalled();
    const projectDir = await readdir(projectMemoryDir()).catch(() => null);
    if (projectDir !== null) expect(projectDir).toEqual([]);
  });

  it('rejects a slug with unsafe characters and names the allowed pattern', async () => {
    const writeSpy = vi.spyOn(localKaos, 'writeText');

    const result = await runTool({
      operation: 'write',
      scope: 'project',
      record: {
        name: 'FOO BAR/..',
        description: 'attempted unsafe slug',
        type: 'project',
      },
      body: 'noop',
    });

    expect(result.isError).toBe(true);
    const output = typeof result.output === 'string' ? result.output : '';
    expect(output).toContain('INVALID_SLUG');
    expect(output.toLowerCase()).toContain('kebab-case');

    expect(writeSpy).not.toHaveBeenCalled();
    const projectDir = await readdir(projectMemoryDir()).catch(() => null);
    if (projectDir !== null) expect(projectDir).toEqual([]);
  });

  it('rejects a slug with a leading hyphen', async () => {
    const writeSpy = vi.spyOn(localKaos, 'writeText');

    const result = await runTool({
      operation: 'write',
      scope: 'project',
      record: {
        name: '-leading',
        description: 'leading hyphen',
        type: 'project',
      },
      body: 'noop',
    });

    expect(result.isError).toBe(true);
    const output = typeof result.output === 'string' ? result.output : '';
    expect(output).toContain('INVALID_SLUG');

    expect(writeSpy).not.toHaveBeenCalled();
    const projectDir = await readdir(projectMemoryDir()).catch(() => null);
    if (projectDir !== null) expect(projectDir).toEqual([]);
  });

  it('refuses to read a symlink stored under the memory directory', async () => {
    await mkdir(projectMemoryDir(), { recursive: true });
    const sentinelPath = join(workDir, 'sentinel-secret.txt');
    await writeFile(sentinelPath, 'CONFIDENTIAL', 'utf-8');
    await symlink(sentinelPath, join(projectMemoryDir(), 'trap.md'));

    const readTextSpy = vi.spyOn(localKaos, 'readText');

    const result = await runTool({ operation: 'read', scope: 'project', name: 'trap' });

    expect(result.isError).toBe(true);
    const output = typeof result.output === 'string' ? result.output : '';
    expect(output.toUpperCase()).toContain('SYMLINK');

    const readSentinel = readTextSpy.mock.calls.some(([path]) => path === sentinelPath);
    expect(readSentinel).toBe(false);

    // Sentinel content must not appear in tool output either.
    expect(output).not.toContain('CONFIDENTIAL');
  });
});

describe('MemoryTool telemetry', () => {
  type TrackCall = readonly [string, Readonly<Record<string, unknown>> | undefined];

  const makeTelemetry = (): { client: TelemetryClient; calls: TrackCall[] } => {
    const calls: TrackCall[] = [];
    const client: TelemetryClient = {
      track: (event, properties) => {
        calls.push([event, properties as Readonly<Record<string, unknown>> | undefined]);
      },
    };
    return { client, calls };
  };

  const runWithTelemetry = async (
    args: MemoryInput,
    telemetry: TelemetryClient,
  ): Promise<ExecutableToolResult> => {
    const tool = new MemoryTool(localKaos, workspace(), telemetry);
    const execution: ToolExecution = tool.resolveExecution(args);
    if (execution.isError === true) return execution;
    return execution.execute({ turnId: '0', toolCallId: 'call_memory', signal });
  };

  it('emits memory_write with {scope, slug} (no body) on a successful write', async () => {
    const { client, calls } = makeTelemetry();

    const result = await runWithTelemetry(
      {
        operation: 'write',
        scope: 'project',
        record: {
          name: 'preferred-runner',
          description: 'Use vitest.',
          type: 'project',
        },
        body: 'EXCLUSIVE_BODY_TOKEN',
      },
      client,
    );
    expect(result.isError).not.toBe(true);

    const write = calls.find(([event]) => event === 'memory_write');
    expect(write).toBeDefined();
    const [, payload] = write!;
    expect(payload).toEqual({ scope: 'project', slug: 'preferred-runner' });
    expect(payload).not.toHaveProperty('body');
    // Body content must not leak into any telemetry payload.
    for (const [, props] of calls) {
      const text = JSON.stringify(props ?? {});
      expect(text).not.toContain('EXCLUSIVE_BODY_TOKEN');
    }
  });

  it('emits memory_update with {scope, slug} (no body) on a successful update', async () => {
    await seedFact(
      projectMemoryDir(),
      'build',
      { name: 'build', description: 'Use pnpm.', type: 'project' },
      'old',
    );
    const { client, calls } = makeTelemetry();

    const result = await runWithTelemetry(
      {
        operation: 'update',
        scope: 'project',
        name: 'build',
        body: 'NEW_EXCLUSIVE_TOKEN',
      },
      client,
    );
    expect(result.isError).not.toBe(true);

    const update = calls.find(([event]) => event === 'memory_update');
    expect(update).toBeDefined();
    const [, payload] = update!;
    expect(payload).toEqual({ scope: 'project', slug: 'build' });
    expect(payload).not.toHaveProperty('body');
    for (const [, props] of calls) {
      const text = JSON.stringify(props ?? {});
      expect(text).not.toContain('NEW_EXCLUSIVE_TOKEN');
    }
  });

  it('emits memory_delete with {scope, slug} on a successful delete', async () => {
    await seedFact(
      projectMemoryDir(),
      'obsolete',
      { name: 'obsolete', description: 'Old.', type: 'project' },
    );
    const { client, calls } = makeTelemetry();

    const result = await runWithTelemetry(
      { operation: 'delete', scope: 'project', name: 'obsolete' },
      client,
    );
    expect(result.isError).not.toBe(true);

    const del = calls.find(([event]) => event === 'memory_delete');
    expect(del).toBeDefined();
    expect(del![1]).toEqual({ scope: 'project', slug: 'obsolete' });
  });

  it('does NOT emit memory_write when the write fails (EXISTS)', async () => {
    await seedFact(
      projectMemoryDir(),
      'dup',
      { name: 'dup', description: 'first', type: 'project' },
    );
    const { client, calls } = makeTelemetry();

    const result = await runWithTelemetry(
      {
        operation: 'write',
        scope: 'project',
        record: { name: 'dup', description: 'second', type: 'project' },
        body: 'body',
      },
      client,
    );
    expect(result.isError).toBe(true);

    const write = calls.find(([event]) => event === 'memory_write');
    expect(write).toBeUndefined();
  });

  it('does NOT emit any memory_* event for read-only operations', async () => {
    await seedFact(
      projectMemoryDir(),
      'visible',
      { name: 'visible', description: 'desc', type: 'project' },
    );
    const { client, calls } = makeTelemetry();

    await runWithTelemetry({ operation: 'view' }, client);
    await runWithTelemetry({ operation: 'list', scope: 'project' }, client);
    await runWithTelemetry(
      { operation: 'read', scope: 'project', name: 'visible' },
      client,
    );

    const mutationEvents = calls.filter(([event]) =>
      ['memory_write', 'memory_update', 'memory_delete'].includes(event),
    );
    expect(mutationEvents).toEqual([]);
  });

  it('swallows telemetry sink errors so the tool result remains successful', async () => {
    const throwingTelemetry: TelemetryClient = {
      track: () => {
        throw new Error('telemetry sink down');
      },
    };

    const result = await runWithTelemetry(
      {
        operation: 'write',
        scope: 'project',
        record: { name: 'resilient', description: 'desc', type: 'project' },
        body: 'body',
      },
      throwingTelemetry,
    );

    expect(result.isError).not.toBe(true);
    const output = typeof result.output === 'string' ? result.output : '';
    expect(output).toContain('resilient');
  });
});
