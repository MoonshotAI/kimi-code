// Memory/file output store 的生命周期与持久化测试，不依赖 executor、loop 或模型投影。
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { fileOutputStore, memoryOutputStore } from '#/tool/output-store';

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'core-tool-output-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

describe('memoryOutputStore', () => {
  it('tracks UTF-8 offsets, previews and reads', async () => {
    const output = memoryOutputStore().open('unicode');
    expect(output.append('hello ')).toBe(0);
    expect(output.append('世界')).toBe(6);
    await output.flush();

    expect(output.preview()).toMatchObject({ totalBytes: 12, preview: 'hello 世界', truncated: false });
    expect(await output.read(0, 5)).toBe('hello');
    expect(await output.read(6, 6)).toBe('世界');
    expect(await output.read(12, 1)).toBe('');
  });

  it('treats empty writes as offsets without appending content or events', () => {
    const output = memoryOutputStore().open('empty');
    let notifications = 0;
    output.onAppend?.(() => {
      notifications += 1;
    });
    expect(output.append('')).toBe(0);
    expect(output.append('x')).toBe(0);
    expect(output.append('')).toBe(1);
    expect(notifications).toBe(1);
    expect(output.preview()).toMatchObject({ totalBytes: 1, preview: 'x' });
  });

  // 来源：PR #3227 的 core 输出保留子集，只验证保留窗口与真实 totalBytes，不涉及 agent spill 元数据。
  // https://github.com/MoonshotAI/kimi-code/pull/3227
  it('retains a bounded tail while preserving the true total size', async () => {
    const retained = 1024 * 1024;
    const output = memoryOutputStore().open('retention');
    output.append(`${'x'.repeat(retained)}tail`);

    expect(output.preview(4)).toMatchObject({
      totalBytes: retained + 4,
      preview: 'tail',
      truncated: true,
    });
    expect(await output.read(retained, 4)).toBe('tail');
    expect(await output.read(0, 4)).toBe('');
  });

  it('notifies append listeners and stops after unsubscribe', () => {
    const output = memoryOutputStore().open('listeners');
    const events: string[] = [];
    const unsubscribe = output.onAppend?.((chunk, offset) => {
      events.push(`${chunk}:${offset}`);
    });
    output.append('a');
    unsubscribe?.();
    output.append('b');
    expect(events).toEqual(['a:0']);
    expect(output.preview().preview).toBe('ab');
  });

  it('rejects writes after close while preserving reads and close idempotence', async () => {
    const output = memoryOutputStore().open('closed');
    output.append('saved');
    const closing = output.close();
    expect(output.close()).toBe(closing);
    await closing;

    expect(output.closed).toBe(true);
    expect(output.append('ignored')).toBeUndefined();
    expect(output.error()).toBe('Tool output is closed');
    expect(output.preview()).toMatchObject({ preview: 'saved', error: 'Tool output is closed' });
    expect(await output.read(0, 5)).toBe('saved');
  });

  it('allows one writer at a time and releases the writer on close', async () => {
    const store = memoryOutputStore();
    const first = store.open('writer');
    const second = store.open('writer');
    expect(second.append('blocked')).toBeUndefined();
    expect(second.error()).toBe('Tool output is already open for writing');

    await first.close();
    const third = store.open('writer');
    expect(third.append('accepted')).toBe(0);
    await third.close();
  });
});

describe('As a long-running tool caller, I want bounded output retention and safe read limits so that streaming output remains usable', () => {
  it('evicts old chunks across several appends while preserving totalBytes and the tail', async () => {
    const retained = 1024 * 1024;
    const half = retained / 2;
    const output = memoryOutputStore().open('chunked-retention');
    expect(output.append('x'.repeat(half))).toBe(0);
    expect(output.append('x'.repeat(half))).toBe(half);
    expect(output.append('tail')).toBe(retained);

    expect(output.preview(4)).toMatchObject({
      totalBytes: retained + 4,
      preview: 'tail',
      truncated: true,
    });
    expect(await output.read(0, 1)).toBe('');
    expect(await output.read(retained, 4)).toBe('tail');
  });

  it('uses byte-count defaults for non-finite preview and read arguments', async () => {
    const output = memoryOutputStore().open('non-finite-counts');
    output.append('abc');

    expect(output.preview(Number.POSITIVE_INFINITY)).toMatchObject({
      totalBytes: 3,
      preview: 'abc',
    });
    expect(await output.read(Number.NaN, 3)).toBe('abc');
    expect(await output.read(0, Number.POSITIVE_INFINITY)).toBe('');
  });
});

describe('fileOutputStore', () => {
  // 来源：PR #3227 的 core 文件恢复子集，验证关闭后仍可读取原始内容，不覆盖 agent 级 spill 文案。
  // https://github.com/MoonshotAI/kimi-code/pull/3227
  it('restores bytes, offsets, previews and reads after close and reopen', async () => {
    const directory = await temporaryDirectory();
    const initial = fileOutputStore(directory).open('restart-task');
    expect(initial.append('hello ')).toBe(0);
    expect(initial.append('世界')).toBe(6);
    await initial.close();

    const reopened = fileOutputStore(directory).open('restart-task');
    expect(reopened.preview()).toMatchObject({
      totalBytes: 12,
      preview: 'hello 世界',
      path: join(directory, 'restart-task.log'),
    });
    expect(await reopened.read(0, 5)).toBe('hello');
    expect(reopened.append('!')).toBe(12);
    await reopened.close();

    const reader = fileOutputStore(directory).open('restart-task');
    expect(reader.preview()).toMatchObject({ totalBytes: 13, preview: 'hello 世界!' });
    expect(await reader.read(6, 6)).toBe('世界');
    expect(await reader.read(12, 1)).toBe('!');
    await reader.close();
  });

  it('restores the retained tail and original file size after a large append', async () => {
    const directory = await temporaryDirectory();
    const retained = 1024 * 1024;
    const output = fileOutputStore(directory).open('large-task');
    output.append(`${'x'.repeat(retained)}tail`);
    await output.close();

    const restored = fileOutputStore(directory).open('large-task');
    expect(restored.preview(4)).toMatchObject({
      totalBytes: retained + 4,
      preview: 'tail',
      truncated: true,
    });
    expect(await restored.read(0, 1)).toBe('x');
    expect(await restored.read(retained, 4)).toBe('tail');
    await restored.close();
  });

  it('returns a failed output for invalid task ids without writing outside the store', async () => {
    const directory = await temporaryDirectory();
    const output = fileOutputStore(directory).open('../escape');
    expect(output.append('blocked')).toBeUndefined();
    expect(output.error()).toBe('Invalid task id: ../escape');
    expect(output.preview()).toMatchObject({
      totalBytes: 0,
      preview: '',
      error: 'Invalid task id: ../escape',
    });
    expect(await output.read(0, 10)).toBe('');
    await expect(output.flush()).rejects.toThrow('Invalid task id: ../escape');
    await expect(output.close()).rejects.toThrow('Invalid task id: ../escape');
  });

  it('surfaces persistence failures through flush and error state', async () => {
    const directory = await temporaryDirectory();
    const file = join(directory, 'not-a-directory');
    await writeFile(file, 'file');
    const output = fileOutputStore(join(file, 'nested')).open('failed-task');
    expect(output.append('x')).toBeUndefined();
    await expect(output.flush()).rejects.toThrow();
    expect(output.error()).toBeTypeOf('string');
  });

});

describe('As an output consumer, I want explicit persistence failures and safe file restoration so that saved output is never silently lost', () => {
  it('records the first asynchronous persistence failure and skips queued writes', async () => {
    const directory = await temporaryDirectory();
    const output = fileOutputStore(directory).open('queued-failure');
    await rm(directory, { recursive: true });
    await writeFile(directory, 'file');

    expect(output.append('first')).toBe(0);
    expect(output.append('second')).toBe(5);
    await expect(output.flush()).rejects.toThrow();
    const failure = output.error();
    expect(failure).toBeTypeOf('string');
    expect(output.preview()).toMatchObject({ totalBytes: 11, error: failure });
  });

  it('returns an empty read when the persisted file disappears', async () => {
    const directory = await temporaryDirectory();
    const output = fileOutputStore(directory).open('disappearing-task');
    output.append('saved');
    await output.close();
    await rm(join(directory, 'disappearing-task.log'));

    expect(await output.read(0, 5)).toBe('');
  });

  it('restores an existing empty log without failure', async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, 'empty-task.log'), '');
    const output = fileOutputStore(directory).open('empty-task');

    expect(output.preview()).toMatchObject({
      totalBytes: 0,
      preview: '',
      truncated: false,
      error: undefined,
    });
    expect(output.append('x')).toBe(0);
    await output.close();
    expect(await output.read(0, 1)).toBe('x');
  });
});
