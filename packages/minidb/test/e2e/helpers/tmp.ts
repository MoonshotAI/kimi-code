// test/e2e/helpers/tmp.js
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function tmpDir(prefix = 'minidb-e2e-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function rmrf(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

export async function fileSize(p) {
  try {
    return (await fs.stat(p)).size;
  } catch {
    return 0;
  }
}
