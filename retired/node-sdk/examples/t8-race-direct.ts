// Direct race demo: emulates SessionStore.create logic but inserts a delay
// between findSessionEntry and appendSessionIndexEntry to expose the TOCTOU.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

function sessionIndexPathLocal(homeDir: string): string {
  return join(homeDir, 'session_index.jsonl');
}
async function readIndexLocal(homeDir: string): Promise<Map<string, any>> {
  try {
    const raw = await readFile(sessionIndexPathLocal(homeDir), 'utf-8');
    const m = new Map<string, any>();
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      const e = JSON.parse(t);
      m.set(e.sessionId, e);
    }
    return m;
  } catch {
    return new Map();
  }
}
async function appendIndexLocal(homeDir: string, entry: any): Promise<void> {
  await mkdir(homeDir, { recursive: true, mode: 0o700 });
  await appendFile(sessionIndexPathLocal(homeDir), `${JSON.stringify(entry)}\n`, 'utf-8');
}

const workDir = process.argv[2]!;
const homeDir = process.argv[3]!;
const sessionId = process.argv[4]!;
const label = process.argv[5] ?? 'P';
const delayMs = Number(process.argv[6] ?? '0');

async function emulateCreate(): Promise<void> {
  const sessionsDir = join(homeDir, 'sessions');
  // Step 1: check index
  const idx = await readIndexLocal(homeDir);
  const present = idx.has(sessionId);
  console.log(JSON.stringify({ label, step: 'check', present, pid: process.pid, t: Date.now() }));
  if (present) {
    console.log(JSON.stringify({ label, step: 'reject', pid: process.pid }));
    return;
  }
  // Step 2: simulate "isDirectory" check + mkdir gap
  const dir = join(sessionsDir, 'wd_dummy', sessionId);
  // recursive mkdir is non-fatal if exists
  if (delayMs > 0) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    });
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Step 3: append index
  await appendIndexLocal(homeDir, { sessionId, sessionDir: dir, workDir });
  console.log(JSON.stringify({ label, step: 'append', pid: process.pid, t: Date.now() }));
}

await emulateCreate();
process.exit(0);
