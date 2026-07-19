/**
 * `skillCatalog` domain (L3) — `SkillRootWatcher` integration test against the
 * real chokidar watcher on temporary directories.
 *
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/app/skillCatalog/skillRootWatcher.test.ts`.
 */

import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { afterEach, describe, expect, it } from 'vitest';

import { SkillRootWatcher } from '#/app/skillCatalog/skillRootWatcher';
import { HostFsWatchService } from '#/os/backends/node-local/hostFsWatchService';

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// chokidar arm latency slack; the watcher's own debounce is 300 ms.
const SETTLE_MS = 300;
const DEBOUNCE_WINDOW_MS = 1000;

describe('SkillRootWatcher', () => {
  let base: string;
  let watcher: SkillRootWatcher | undefined;

  afterEach(async () => {
    watcher?.dispose();
    watcher = undefined;
    if (base) await rm(base, { recursive: true, force: true });
  });

  async function makeBase(): Promise<string> {
    base = realpathSync(await mkdtemp(join(tmpdir(), 'skill-watch-')));
    return base;
  }

  function start(roots: () => Promise<readonly string[]>): { fires: () => number } {
    let fires = 0;
    watcher = new SkillRootWatcher(
      new HostFsWatchService(),
      roots,
      () => {
        fires += 1;
      },
    );
    return { fires: () => fires };
  }

  it('debounces a burst of writes under an existing root into a single fire', async () => {
    const root = join(await makeBase(), 'skills');
    await mkdir(root, { recursive: true });
    const { fires } = start(async () => [root]);
    await watcher!.ready;
    await wait(SETTLE_MS);

    for (let i = 0; i < 5; i += 1) {
      await writeFile(join(root, `f${i}.md`), 'x');
      await wait(30);
    }
    await wait(DEBOUNCE_WINDOW_MS);

    expect(fires()).toBe(1);
  }, 20000);

  it('fires when a root with multiple missing leading segments is created', async () => {
    const root = join(await makeBase(), '.agents', 'skills');
    const { fires } = start(async () => [root]);
    await watcher!.ready;
    await wait(SETTLE_MS);
    expect(fires()).toBe(0);

    await mkdir(join(root, 'demo'), { recursive: true });
    await writeFile(join(root, 'demo', 'SKILL.md'), 'x');
    await wait(DEBOUNCE_WINDOW_MS);

    expect(fires()).toBe(1);
  }, 20000);

  it('keeps firing after the root is deleted and recreated', async () => {
    const root = join(await makeBase(), 'skills');
    await mkdir(join(root, 'demo'), { recursive: true });
    await writeFile(join(root, 'demo', 'SKILL.md'), 'x');
    const { fires } = start(async () => [root]);
    await watcher!.ready;
    await wait(SETTLE_MS);

    await rm(root, { recursive: true, force: true });
    await wait(DEBOUNCE_WINDOW_MS);
    const afterDelete = fires();
    expect(afterDelete).toBeGreaterThanOrEqual(1);

    await mkdir(join(root, 'demo'), { recursive: true });
    await writeFile(join(root, 'demo', 'SKILL.md'), 'y');
    await wait(DEBOUNCE_WINDOW_MS);

    expect(fires()).toBeGreaterThan(afterDelete);
  }, 20000);

  it('re-arms onto roots returned by the resolver after refresh()', async () => {
    const baseDir = await makeBase();
    const rootA = join(baseDir, 'a');
    const rootB = join(baseDir, 'b');
    await mkdir(rootA, { recursive: true });
    await mkdir(rootB, { recursive: true });
    let current: readonly string[] = [rootA];
    const { fires } = start(async () => current);
    await watcher!.ready;
    await wait(SETTLE_MS);

    current = [rootB];
    await watcher!.refresh();
    await wait(SETTLE_MS);

    await writeFile(join(rootA, 'a.md'), 'x');
    await writeFile(join(rootB, 'b.md'), 'x');
    await wait(DEBOUNCE_WINDOW_MS);

    expect(fires()).toBe(1);
  }, 20000);

  it('stops firing after dispose', async () => {
    const root = join(await makeBase(), 'skills');
    await mkdir(root, { recursive: true });
    const { fires } = start(async () => [root]);
    await watcher!.ready;
    await wait(SETTLE_MS);
    const owned = watcher!;
    watcher = undefined;
    owned.dispose();

    await writeFile(join(root, 'x.md'), 'x');
    await wait(DEBOUNCE_WINDOW_MS);

    expect(fires()).toBe(0);
  }, 20000);
});
