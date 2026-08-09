import { cp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/** Copy a fixture session into a temporary KIMI_CODE_HOME. */
export async function buildSessionFixture(name: string): Promise<{
  home: string;
  sessionDir: string;
  cleanup: () => Promise<void>;
}> {
  // `URL.pathname` on Windows yields `/G:/…` which fs resolves to a doubled
  // drive (`G:\G:\…`) — decode via fileURLToPath instead.
  const src = fileURLToPath(new URL(`./sessions/${name}`, import.meta.url));
  const home = await mkdtemp();
  const sessionsDir = join(home, 'sessions', 'wd_test_000000000000');
  const sessionDir = join(sessionsDir, 'session_fixture');
  await mkdir(sessionsDir, { recursive: true });
  await cp(src, sessionDir, { recursive: true });

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
