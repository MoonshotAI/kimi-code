/**
 * Test helper — probe whether the current process may create symlinks.
 *
 * On Windows, `fs.symlink` requires SeCreateSymbolicLinkPrivilege (an
 * elevated shell or Developer Mode); without it the call rejects with EPERM.
 * `canCreateSymlinks()` probes once and caches the result, so
 * symlink-dependent tests can skip when unsupported:
 *
 * ```ts
 * it('follows symlinks', async (ctx) => {
 *   if (!(await canCreateSymlinks())) ctx.skip();
 *   // …
 * });
 * ```
 */

import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let probe: Promise<boolean> | undefined;

export function canCreateSymlinks(): Promise<boolean> {
  probe ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-symlink-probe-'));
    try {
      const target = join(dir, 'target.txt');
      await writeFile(target, 'probe', 'utf8');
      await symlink(target, join(dir, 'link.txt'));
      return true;
    } catch {
      return false;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  })();
  return probe;
}
