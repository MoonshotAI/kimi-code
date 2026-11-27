import { createRequire } from 'node:module';

export default function installElectronBinaryBeforeWorkersStart(): void {
  createRequire(import.meta.url)('electron');
}
