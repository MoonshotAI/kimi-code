/**
 * Test helper — build a shell command that runs an inline Node.js script on
 * any platform.
 *
 * `node -e "<script>"` does not survive `shell: true` on Windows: cmd.exe
 * toggles its quoting state at every `"` (it does not understand `\"`),
 * shredding a script that contains double quotes into multiple arguments.
 * Writing the script to a temp file and invoking `node <file>` avoids shell
 * quoting entirely on both cmd.exe and POSIX shells.
 *
 * `nodeScriptCommand(source)` writes `source` to a unique temp `.cjs` file
 * (CommonJS, so `require` works) under the OS temp dir — cleaned up on
 * process exit — and returns the quoted command string; `quotePath(path)`
 * wraps one path in double quotes, which both cmd.exe and POSIX shells treat
 * as literal (backslashes included).
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scriptDir = join(tmpdir(), `kimi-test-scripts-${process.pid}`);
let scriptCounter = 0;
let cleanupRegistered = false;

function quotePath(path: string): string {
  return `"${path}"`;
}

export function nodeScriptCommand(source: string): string {
  mkdirSync(scriptDir, { recursive: true });
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    process.on('exit', () => {
      rmSync(scriptDir, { recursive: true, force: true });
    });
  }
  const scriptPath = join(scriptDir, `script-${scriptCounter++}.cjs`);
  writeFileSync(scriptPath, source, 'utf8');
  return `${quotePath(process.execPath)} ${quotePath(scriptPath)}`;
}
