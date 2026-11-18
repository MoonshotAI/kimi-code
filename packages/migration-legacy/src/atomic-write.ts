import { chmod, rename, writeFile } from 'node:fs/promises';

export async function atomicWrite(path: string, data: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data, { encoding: 'utf-8', mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}
