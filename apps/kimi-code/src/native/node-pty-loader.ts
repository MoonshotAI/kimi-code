import { createRequire } from 'node:module';
import type * as NodePty from 'node-pty';

import { loadNativePackage } from './native-require';

type NodePtyModule = typeof NodePty;

const nodeRequire = createRequire(import.meta.url);

export async function importNodePty(): Promise<NodePtyModule> {
  const cached = loadNativePackage<NodePtyModule>('node-pty');
  if (cached !== null) return cached;
  return nodeRequire('node-pty') as NodePtyModule;
}

export function installNodePtyLoader(): void {
  (globalThis as { __kimiImportNodePty?: typeof importNodePty }).__kimiImportNodePty =
    importNodePty;
}
