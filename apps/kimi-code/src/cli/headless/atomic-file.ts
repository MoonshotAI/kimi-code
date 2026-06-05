import { open, rename } from 'node:fs/promises';

export async function writeAtomicTextFile(filePath: string, text: string): Promise<void> {
  const tempPath = `${filePath}.tmp`;
  const handle = await open(tempPath, 'w');
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, filePath);
}

export async function writeAtomicJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeAtomicTextFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
