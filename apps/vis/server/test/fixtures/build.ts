import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Copy a fixture session into a temp dir, rewriting state.json.agents.*.homedir
 *  to the real path so wire-reader / agent-tree can resolve them. */
export async function buildSessionFixture(name: string): Promise<{
  home: string;
  sessionDir: string;
  cleanup: () => Promise<void>;
}> {
  const src = new URL(`./sessions/${name}`, import.meta.url).pathname;
  const home = await mkdtemp();
  const sessionsDir = join(home, 'sessions', 'wd_test_000000000000');
  const sessionDir = join(sessionsDir, 'session_fixture');
  await mkdir(sessionsDir, { recursive: true });
  await cp(src, sessionDir, { recursive: true });

  // Rewrite homedir placeholders.
  const statePath = join(sessionDir, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  for (const id of Object.keys(state.agents)) {
    state.agents[id].homedir = join(sessionDir, 'agents', id);
  }
  await writeFile(statePath, JSON.stringify(state, null, 2));

  // Write session_index.jsonl.
  await writeFile(
    join(home, 'session_index.jsonl'),
    JSON.stringify({
      sessionId: 'session_fixture',
      sessionDir,
      workDir: '/tmp/work',
    }) + '\n',
  );

  return {
    home,
    sessionDir,
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

async function mkdtemp(): Promise<string> {
  const base = join(tmpdir(), `vis-fixture-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(base, { recursive: true });
  return base;
}
