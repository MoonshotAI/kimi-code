import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StatusLineRunner } from '#/utils/statusline/status-line-runner';

const NODE = JSON.stringify(process.execPath);

function nodeCommand(script: string): string {
  return `${NODE} -e ${JSON.stringify(script)}`;
}

function makeRunner(command: string, onChange?: () => void): StatusLineRunner {
  return new StatusLineRunner({
    command,
    intervalMs: 60_000,
    timeoutMs: 5_000,
    getInput: () => ({ session_id: 'sess_1' }),
    onChange,
  });
}

describe('StatusLineRunner', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kimi-statusline-runner-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('captures the first stdout line of a successful run', async () => {
    const runner = makeRunner(nodeCommand(`process.stdout.write('hello statusline')`));

    await runner.runOnce();

    expect(runner.getOutput()).toBe('hello statusline');
  });

  it('keeps only the first line of multi-line output', async () => {
    const runner = makeRunner(nodeCommand(`process.stdout.write('first\\nsecond\\n')`));

    await runner.runOnce();

    expect(runner.getOutput()).toBe('first');
  });

  it('passes the getInput payload as stdin JSON', async () => {
    const runner = makeRunner(
      nodeCommand(
        `let d='';process.stdin.on('data',(c)=>{d+=c}).on('end',()=>process.stdout.write(JSON.parse(d).session_id))`,
      ),
    );

    await runner.runOnce();

    expect(runner.getOutput()).toBe('sess_1');
  });

  it('kills the command on timeout and reports no output', async () => {
    const runner = new StatusLineRunner({
      command: nodeCommand(`setTimeout(() => {}, 60_000)`),
      intervalMs: 60_000,
      timeoutMs: 200,
      getInput: () => ({}),
    });
    const startedAt = Date.now();

    await runner.runOnce();

    expect(runner.getOutput()).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('preserves the last successful output after a failing run', async () => {
    const marker = join(dir, 'marker');
    // First run succeeds and creates the marker; later runs exit non-zero.
    const runner = makeRunner(
      nodeCommand(
        `const fs=require('fs');if(fs.existsSync(${JSON.stringify(marker)})){process.exit(1)}fs.writeFileSync(${JSON.stringify(marker)},'1');process.stdout.write('good')`,
      ),
    );

    await runner.runOnce();
    expect(runner.getOutput()).toBe('good');
    await runner.runOnce();
    expect(runner.getOutput()).toBe('good');
  });

  it('stays silent when the command never succeeds', async () => {
    const runner = makeRunner(nodeCommand(`process.exit(1)`));

    await runner.runOnce();

    expect(runner.getOutput()).toBeNull();
  });

  it('notifies onChange only when the output changes', async () => {
    let notifications = 0;
    const runner = makeRunner(nodeCommand(`process.stdout.write('same')`), () => {
      notifications += 1;
    });

    await runner.runOnce();
    await runner.runOnce();

    expect(notifications).toBe(1);
  });
});
